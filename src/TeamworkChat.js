import Promise from "bluebird";
import Debug from "debug";
import { inspect } from "util";
import { omit, values, flatten, without, uniqBy, intersection } from "lodash";
import APIClient from "./APIClient";
import Room from "./Room";
import Person from "./Person";
import Message from "./Message";

const debug = Debug("tw-chat");

/**
 * The time in ms to wait between reconnection attempts.
 * @type {Number}
 */
const RECONNECT_INTERVAL = 1000 * 3;

export default class TeamworkChat extends Person {
    /**
     * The rooms store. We use an array instead of and object keyed with room IDs because
     * rooms are stored in an initialized (with ID) and uninitialized (without ID) states.
     * We therefore can't store them in an object by ID because we would have a bunch of
     * `undefined` keys.
     *
     * @type {Array}
     */
    rooms = [];

    constructor(api, user) {
        super(api, user);

        this.api.user = this;
        this.update(user.user);
        this.room.addPerson(this);

        this.api.once("connected", this.emit.bind(this, "connected"));
        this.api.on("frame", this.onFrame.bind(this));
        this.api.on("close", this.onDisconnect.bind(this));

        // Listen for person updates on the global room
        this.room.on("person:new", this.emit.bind(this, "person:new"));
        this.room.on("person:update", this.emit.bind(this, "person:update"));

        // Adding "error" listener to stop the EventEmitter from throwing the error if no listeners are attached.
        this.on("error", debug.bind(null, "TeamworkChat Error:"));
    }


    /**
     * Event Handler: when the APIClient's socket `close`'s.
     */
    onDisconnect(attempt = 0) {
        if(this.forceClosed) {
            // If the socket was force close (i.e. TeamworkChat.close), we
            // don't want to attempt to reconnect so we exit.
            return;
        }

        if(attempt === 0) {
            debug("socket disconnected");
            this.emit("disconnect");
        } else {
            debug(`socket reconnect failed, attempting to reconnect (attempt ${attempt})`);
        }

        return this.api.connect().then(() => {
            debug("socket reconnected");
            this.emit("reconnect");
        }).catch(error => {
            debug("unable to reconnect socket", error);
            return Promise.delay(RECONNECT_INTERVAL).then(this.onDisconnect.bind(this, attempt + 1));
        });
    }

    /**
     * Event Handler: when the APIClient's socket recieves a `frame`
     * @param  {Object} frame Parsed socket frame.
     */
    onFrame(frame) {
        Promise.try(() => {
            switch(frame.name) {
                case "room.message.created":
                    const message = frame.contents;
                    debug("new message", message);

                    if(!message.roomId) {
                        throw new Error(
                            "Malformed frame: `room.message.created` has no room ID. Unable " + 
                            "to direct message to correct room. Ignoring frame."
                        );
                    }

                    return this.getRoom(message.roomId).then(room => {
                        return room.handleMessage(message)
                    });
                break;

                case "pong":
                    this.emit("pong");
                break;

                case "user.modified":
                    const update = frame.contents;
                    const person = this.findPersonById(update.userId)

                    if(person) {
                        person.update({ [update.key]: update.value });
                    } else {
                        debug(`Warning: user with ID ${update.userId} not loaded in memory, discarding frame.`);
                    }
                break;

                default:
                    debug(`unknown frame "${frame.name}", ignoring.`, frame);
            }
        }).catch(error => {
            // Attach the frame to the error for debugging purposes
            error.frame = frame;

            this.emit("error", error);
        });
    }

    /**
     * Override ability to send message to a Person object as this is an error,
     * the consumer would be attempting to send a message to themselves.
     * 
     * @throws {Error} (Always)
     */
    sendMessage() {
        throw new Error("Illegal operation: cannot send to self.");
    }

    createRoomWithHandles(handles) {
        return Promise.all(handles.map(this.getPersonByHandle.bind(this))).then(people => {
            return new Room(this.api, undefined, people);
        });
    }

    getRoomForHandles(handles) {
        if(handles.length === 1 || (handles.length === 2 && handles.includes(this.handle))) {
            return this.getPersonByHandle(without(handles, this.handle)[0]).then(person => person.room);
        } else {
            let room = this.findRoomForHandles(handles);

            if(!room) {
                // Workaround: The Chat API doesn't directly have an API to get a room by user's
                // handles. What it does have though is if you attempt to send a message to a bunch
                // of handles, it will either return the room ID containing all the users or create
                // the room. We therefore leave it up to the `Room.sendMessage` to initialize itself
                // and return the uninitialized room here.
                debug(
                    "Warning: Room with more than one participant returned from `getRoomForHandles` is " +
                    "uninitialized. To initialize, send a message using `sendMessage`."
                );

                return this.createRoomWithHandles(handles);
            } else return Promise.resolve(room);
        }
    }

    getUnseenCount() {
        return this.api.getUnseenCount().then(({ contents }) => {
            const conv = contents.conversationUnreadCounts;
            const room = contents.unreadCounts;

            return {
                important: {
                    rooms: room.importantUnread,
                    conversations: conv ? conv.importantUnread : null
                },

                total: {
                    rooms: room.unread,
                    conversations: conv ? conv.unread : null
                }
            };
        });
    }

    updateStatus(status) {
        return this.api.updateStatus(status);
    }

    findRoomForHandles(handles) {
        return this.rooms.find(room => {
            return intersection(room.people.map(person => person.handle), handles).length === handles.length;
        });
    }

    addRoom(room) {
        // Listen to updates on the room object and proxy them through this instance
        room.on("message", this.emit.bind(this, "message", room));
        room.on("update", this.emit.bind(this, "room:update"));

        // Emit the new room event
        this.emit("room:new", room);

        debug("new room", room);
        this.rooms.push(room);

        return room;
    }

    saveRoom(rawRoom) {
        let room = this.findRoomById(rawRoom.id);

        if(room) {
            return room.update(rawRoom);
        } else {
            const details = omit(rawRoom, "people");
            const participants = rawRoom.people && rawRoom.people.map(person => this.savePerson(person));

            // Test if it's a direct conversation with the current user
            if(participants && participants.length === 2 && participants.includes(this)) {
                // If so, we can get the room attached to the user
                const [ directUser ] = without(participants, this);

                directUser.room.update(details);

                return directUser.room;
            } else {
                return this.addRoom(new Room(this.api, details, participants));
            }
        }
    }

    getRoom(id) {
        const room = this.findRoomById(id);

        if(!room) {
            return this.api.getRoom(id).then(({ room }) => this.saveRoom(room));
        } else return Promise.resolve(room);
    }

    findRoomById(id) {
        return this.rooms.find(room => room.id === id);
    }

    getRooms(offset, limit) {
        return this.api.getRooms(offset, limit).then(res => {
            // First, we need to create the people. This creates the direct conversation
            // rooms with the current user which we will attempt to match later if we
            // come across later when a conversation contains on the current user and
            // another person.
            const people = uniqBy(flatten(res.conversations.map(({ people }) => people)), "id").map(this.savePerson.bind(this));

            // Next, we loop over all the conversations. If we come across a pair room containing
            // the current user (i.e. this.api), then we don't bother creating another room and just
            // update that direct room (attaches as Person.room).
            const conversations = res.conversations.map(this.saveRoom.bind(this));

            // Assign the return page details (limit, offset) to the returned array to
            // describe what results are returned.
            return Object.assign(conversations, res.meta.page);
        });
    }

    getAllRooms() {
        return this.getRooms().then(rooms => {
            const limit = rooms.total - rooms.limit;

            if(limit > 0) {
                return this.getRooms(rooms.limit, limit).then(rest => rooms.concat(rest));
            } else {
                return rooms;
            }
        });
    }

    findPersonById(id) {
        return this.room.findPersonById(id);
    }
    
    getPerson(id) {
        // This poses the same problems as 
        return this.room.getPerson(id);
    }

    getPersonBy(property, value) {
        let person = values(this.room.people).find(person => person[property] === value);

        // If we don't have a person, try load it from the API. Unfortunately, the API
        // doesn't seem to have an endpoint to get a user by API by handle so we get
        // all the people and pick from the returned list. The reason for the generic
        // function is so we don't have to duplicate this logic for each user property
        // we want to filter e.g. id, handle etc.
        if(!person) {
            debug(
                `Warning: The Chat API does not currently support getting people directly by ${property}. ` +
                "To ensure a user is returned, all people must be fetched first and then the " +
                "users are filtered. This will run slower than expected."
            );

            // Get everyone and save them, pick the person.
            return this.getAllPeople().then(people => {
                const search = people.find(person => person[property] === value);

                if(!search) {
                    throw new Error(`No person found with ${property} "${handle}".`);
                } else return search;
            });
        } else return Promise.resolve(person);
    }

    getPersonByHandle(handle) {
        return this.getPersonBy("handle", handle).then(person => {
            return person;
        });
    }

    getPersonById(id) {
        return this.getPersonBy("id", id);
    }

    savePerson(rawPerson) {
        let person = this.findPersonById(rawPerson.id);

        if(person) {
            return person.update(rawPerson);
        } else {
            person = new Person(this.api, rawPerson);
            this.addRoom(person.room);
            return this.addPerson(person);
        }
    }

    addPerson(person) {
        return this.room.addPerson(person);
    }

    addPeople(people) {
        return this.room.addPeople(people);
    }

    getPeople(offset, limit) {
        return this.api.getPeople(offset, limit).then(({ people }) => people.map(this.savePerson.bind(this)));
    }

    getAllPeople() {
        return this.getPeople();
    }

    toJSON() {
        return {
            ...super.toJSON(),
            api: this.api
        };
    }

    inspect() {
        return `TeamworkChat{current user, ${inspect(this.api)}}`;
    }

    close() {
        // Don't attempt to close the socket a second time
        if(this.forceClosed) 
            return;

        this.forceClosed = true;
        this.api.close();
    }

    emit(eventName, ...args) {
        // Convert Person "update" event to "user:update". Quite hacky but works. 
        if(eventName === "update")
            eventName = "user:update";

        return super.emit(eventName, ...args);
    }

    static fromCredentials(installation, username, password) {
        debug(`logging in with user ${username} to ${installation}.`);
        return APIClient.loginWithCredentials(installation, username, password).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }

    /**
     * Use TeamworkChat with a promise "disposer" pattern. This is like `fromCredentials` except
     * you pass it a callback where you use the first parameter, `chat` (the initialized TeamworkChat)
     * instance and return any promise. When that returned promises finishes execution (regardless of
     * outcome -- rejection or resolving), the `disposer` function is called and the socket to Chat is
     * closed. This allows the process to exit appropriately and ensures any open sockets are closed.
     * 
     * @param  {String}   installation The fully qualified installation URL.
     * @param  {String}   username     The username used to login to Teamwork.
     * @param  {String}   password     The password used to login to Teamwork (disposed after initial login request).
     * @param  {Function} callback     The callback (!) that has param `chat` TeamworkChat instance. This returns
     *                                 a promise that when complete, closes the connection to Teamwork.
     * @return {Promise}               Resolves to nothing but ensures connection to Teamwork is closed fully.
     */
    static withCredentials(installation, username, password, callback) {
        return Promise.using(TeamworkChat.fromCredentials(installation, username, password).disposer(chat => {
            chat.close();
        }), callback);
    }
}