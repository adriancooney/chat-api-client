import Promise from "bluebird";
import { inspect } from "util";
import moment from "moment";
import { omit, values, flatten, without, uniqBy, intersection, range, last, difference } from "lodash";
import logging from "./lib/logging";
import APIClient from "./APIClient";
import Room from "./Room";
import Person from "./Person";
import Message from "./Message";

const logger = logging.add("tw-chat");

/**
 * The time in ms to wait between reconnection attempts.
 * @type {Number}
 */
const RECONNECT_INTERVAL = 1000 * 3;

/**
 * TeamworkChat model.
 *
 * Takes care of creating, updating and deleting Person, Room and Message objects
 * by accepting frames and handling fresh data.
 *
 * Events:
 *
 *      "user:update": ({Person} person, {Object} changes)
 *
 *          Emitted when the currently logged in user has been updated.
 *
 *      "person:new": ({Person} person)
 *
 *          A new person was added to the memory store. This DOES NOT MEAN a new
 *          person was added to the company or projects, just that they have been
 *          loaded into memory. Once they have all been loaded into memory and this
 *          event happens, it's safe to assume the person was recently created in
 *          projects. See `person:created` for a new person added to Projects.
 *
 *      "person:updated": ({Person} person, {Object} changes)
 *
 *          A person was updated e.g. their status, "offline" to "online"
 *
 *      "person:created": ({Person} person)
 *
 *          When a new person is created in Projects.
 *
 *      "message": ({Room} room, {Message} message)
 *
 *          When a room receives a message (i.e. emitted for ALL messages the current user can see)
 *
 *      "message:direct": ({Message} message)
 *
 *          When the currently logged in user recieves a direct message. The first parameter is
 *          the user that send the message. To get the author of the message, use `message.author` ({Person}).
 *
 *      "message:mention": ({Room} room, {Message} message)
 *
 *          When the currently logged in user is mentioned in a room. To get the author of the
 *          message, use `message.author` ({Person}).
 *
 *      "room:new": ({Room} room)
 *
 *          When a new room is added. Again does does NOT MEAN a new room was created on the
 *          server, only that it was loaded in memory. It can be assume however that after
 *          all rooms are loaded into memory and this event is fired, a new room has been
 *          created.
 *
 *      "room:update": ({Room} room, {Object} changes)
 *
 *          Emitted when a room is updated.
 *
 *      "pong":
 *
 *          Emitted when the client and server successfully completed the ping-pong frame
 *          exchange. Happens a lot, you probably won't need this frame ..unless ..maybe
 *          ..you like ping-pong.
 *
 *      "error": ({Error} error)
 *
 *          Emitted when an error occurs in the APIClient or processing an incoming frame.
 *
 *      "disconnect":
 *
 *          Emitted when the APIClient disconnects from the server. There is no need to
 *          attempt to reconnect or anything related to re-establishing the connection,
 *          the APIClient does that for you. This is just a notification to buffer messages
 *          to be sent until reconnection.
 *
 *      "reconnect": ({Person[]} people, {Room[]} rooms, {Message[]} messages, {moment.duration} downtime)
 *
 *          Emitted when the APIClient has disconnected and manages to reconnect to the API.
 *          The missed information between the disconnect and reconnect is passed as parameters.
 *          A fourth parameter called `downtime` also tells you how long you disconnected from the API.
 *
 */
export default class TeamworkChat extends Person {
    /**
     * The rooms store. We use an array instead of and object keyed with room IDs because
     * rooms are stored in an initialized (with ID) and uninitialized (without ID) states.
     * We therefore can't store them in an object by ID because we would have a bunch of
     * `undefined` keys.
     *
     * @type {Room[]}
     */
    rooms = [];

    /**
     * Stats about this current session.
     * @type {Object}
     */
    monitor = {
        epoch:  moment(),                   // Initialization time
        downtime: moment.duration(0),       // Duration of downtime
        initialConnectionTimestamp: null,   // The timestamp of the first connection
        lastDisconnectTimestamp: null,      // The timestamp of the last disconnect
        disconnects: 0,                     // Disconnection counts
        reconnects: 0                       // Disconnection counts
    };

    /**
     * The people currently loaded in TeamworkChat.
     *
     * @return {Person[]}
     */
    get people() {
        return this.room.people;
    }

    /**
     * Create a new TeamworkChat instance.
     *
     * @param  {APIClient}  api  An authorized APIClient instance.
     * @param  {Object}     user User data to pass to Person#constructor.
     * @return {TeamworkChat}
     */
    constructor(api, user) {
        super(api, user.user);

        this.api.user = this;
        this.room = new Room(api, { id: "root" });
        this.room.addPerson(this);

        this.api.on("frame", this.onFrame.bind(this));
        this.api.on("close", this.onDisconnect.bind(this));

        // Listen for person updates on the global room
        this.room.on("person:new", this.emit.bind(this, "person:new"));
        this.room.on("person:added", this.emit.bind(this, "person:added"));
        this.room.on("person:deleted", this.emit.bind(this, "person:deleted"));
        this.room.on("person:removed", this.emit.bind(this, "person:removed"));
        this.room.on("person:updated", this.emit.bind(this, "person:updated"));

        // Adding "error" listener to stop the EventEmitter from throwing the error if no listeners are attached.
        this.on("error", logger.error.bind(logger));
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
            logger.info("socket disconnected");

            // Update monitoring
            this.monitor.disconnects++;
            this.monitor.lastDisconnectTimestamp = moment();

            this.emit("disconnect");
        } else {
            logger.info(`socket reconnection process failed, attempting to reconnect (attempt ${attempt})`, { attempt });
        }

        return this.connect()
        // .then(() => {
        //     logger.info("socket reconnected to server");
        //     this.monitor.reconnects++;

        //     logger.info("getting updates");
        //     return this.getUpdates(this.monitor.lastDisconnectTimestamp);
        // })
        // .spread((people, rooms, messages) => {
        //     // Calculate the length of time we we're disconnected
        //     const outage = moment.duration(moment().diff(this.monitor.lastDisconnectTimestamp));

        //     // Update the downtime
        //     this.monitor.downtime.add(outage);

        //     // Note: it's okay if this call fails, we will re-attempt it in the catch. Don't
        //     // worry, it won't attempt to reconnect to the websocket again.
        //     this.emit("reconnect", people, rooms, messages, outage);
        // })
        .catch(error => {
            logger.error("unable to reconnect socket and get updates", { error });
            return Promise.delay(RECONNECT_INTERVAL).then(this.onDisconnect.bind(this, attempt + 1));
        });
    }

    /**
     * Event Handler: when the APIClient's socket recieves a `frame`. This is the handler that
     * reads the incoming frame's `name` and handles it appropriately.
     *
     * @param  {Object} frame Parsed socket frame.
     */
    onFrame(frame) {
        Promise.try(() => {
            switch(frame.name) {
                case "room.message.created":
                    const message = frame.contents;
                    logger.debug("new message", { message });

                    if(!message.roomId) {
                        throw new Error(
                            "Malformed frame: `room.message.created` has no room ID. Unable " +
                            "to direct message to correct room. Ignoring frame."
                        );
                    }

                    // The reason we `getRoom` here rather than `findRoom` is because
                    return this.getRoom(message.roomId).then(room => {
                        return room.handleMessage(message);
                    });
                break;

                case "pong":
                    this.emit("pong");
                break;

                case "user.modified":
                    const update = frame.contents;
                    const person = this.findPersonById(update.userId)

                    if(person) {
                        return person.update({ [update.key]: update.value });
                    } else {
                        logger.debug(`Warning: user with ID ${update.userId} not loaded in memory, discarding frame.`, { update });
                    }
                break;

                case "room.updated":
                    // The act of getting the room from the API automatically saves the
                    // room to memory (or updates the existing room).
                    return this.getRoom(frame.contents.id, false).then(room => {
                        logger.debug(`${frame.contents.id} room has been updated`);
                    });
                break;

                case "user.added":
                case "user.updated":
                    // As with `room.updated`, getting them from the API updates the user.
                    return this.getPerson(frame.contents.id, false).then(person => {
                        logger.debug(`${person.id} person has been updated`, { person: person.toJSON() });

                        if(frame.name === "user.added") {
                            this.emit("person:created", person);
                        }
                    });
                break;

                case "unseen.counts.update":
                    logger.debug(
                        "'unseen.counts.update' frame received but discarded, we don't store this information. " +
                        "Use `getUnseenCount` to get counts."
                    );
                break;

                default:
                    logger.debug(`unknown frame "${frame.name}", ignoring.`, { frame: frame });
            }
        }).catch(error => {
            // Attach the frame to the error for debugging purposes
            error.frame = frame;

            console.error(error);

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

    /**
     * Send a message to a person by their handle. See Person#sendMessage for more details.
     *
     * @param  {String} handle      The person's handle.
     * @param  {String} message     See Person#sendMessage for details.
     * @return {Promise<Message>}   See Person#sendMessage for returned details.
     */
    sendMessageToPersonByHandle(handle, message) {
        return this.getPersonByHandle(handle).then(person => person.sendMessage(message));
    }

    /**
     * Create a room with the given handles. WARNING: This DOES NOT create the room
     * server side unless you provide `initialMessage`. The Chat API doesn't have an API
     * to create a room without the first message being sent. If you do not provide an
     * initialMessage, the room will be created in the first `sendMessage` request.
     *
     * @param  {Array<String>}  handles         The list of people's handles (without `@` symbol).
     * @param  {String}         initialMessage  Optional initialMessage to initialize the room (i.e. server side).
     * @return {Promise<Room>}                  The newly created room.
     */
    createRoomWithHandles(handles, initialMessage) {
        return Promise.all(handles.map(this.getPersonByHandle.bind(this))).then(people => {
            return this.addRoom(new Room(this.api, undefined, people));
        }).tap(room => {
            if(initialMessage)  {
                return room.sendMessage(initialMessage);
            }
        });
    }

    /**
     * Get a room containing (only) the people's handles. There's a couple of things to remember
     * when using this method:
     *
     * 1. An existing room with the given handles will not be found unless it has been loaded in
     *    memory (e.g. via getAllRooms). The Chat API does not allow you to find room containing
     *    specific handles.
     * 2. If a room is not found with the given handles, an uninitialized room is created and the
     *    people are added. This room DOES NOT EXIST on the server until the first message is sent
     *    using `Room#sendMessage`.
     *
     * Things to discuss: (TODO: discuss)
     *
     * 1. Should we load all the rooms (if they're not already loaded), then attempt to find the room?
     *    This would be similiar to how `getPersonByHandle` works. It loads all people via `people.json`
     *    and then selects the user via their handle. This isn't ideal but it's how the Chat GUI Client
     *    works. Should we use the same logic here?
     *
     * @param  {Array<String>} handles The list of people's handles (without `@` symbol).
     * @return {Promise<Room>}         The room.
     */
    getRoomForHandles(handles) {
        if(handles.length === 1 || (handles.length === 2 && handles.includes(this.handle))) {
            if(handles.length === 1 && handles.includes(this.handle)) {
                throw new Error("Cannot get room for self.");
            }

            return this.getPersonByHandle(without(handles, this.handle)[0]).then(person => person.room);
        } else {
            const room = this.findRoomForHandles(handles);

            if(!room) {
                // Workaround: The Chat API doesn't directly have an API to get a room by user's
                // handles. What it does have though is if you attempt to send a message to a bunch
                // of handles, it will either return the room ID containing all the users or create
                // the room. We therefore leave it up to the `Room.sendMessage` to initialize itself
                // and return the uninitialized room here.
                logger.warn(
                    "Warning: Room object with more than one participant returned from `getRoomForHandles` is " +
                    "uninitialized. To initialize, send a message using `sendMessage`. This will create the room."
                );

                return this.createRoomWithHandles(handles);
            } else return Promise.resolve(room);
        }
    }

    /**
     * Returned the unseen message counts in the form of:
     *
     *  {
     *    important: { rooms {Number}, conversations {Number} },
     *    total: { rooms: {Number}, conversations: {Number} }
     *  }
     *
     * @return {Promise<Object>} Object containing message counts.
     */
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

    /**
     * Update the currently logged in user's handle.
     *
     * @param  {String}       handle The user's handle (without the `@`).
     * @return {TeamworkChat}        The updated user.
     */
    updateHandle(handle) {
        return this.api.updateHandle(handle).then(() => {
            this.update({ handle });
        });
    }

    /**
     * Update the user's status.
     *
     * @param  {String} status See STATUS_TYPES exported from APIClient for available values.
     * @return {Promise}       Resolves once frame is sent. There is no response from the server
     *                         for this so it's fire and forget.
     */
    updateStatus(status) {
        return this.api.updateStatus(status);
    }

    /**
     * Find a room locally that includes the handles.
     *
     * @param  {Array<String>} handles  The people's handles (without `@`).
     * @return {Room}                   The room, if any.
     */
    findRoomForHandles(handles) {
        return this.rooms.find(room => {
            return intersection(room.people.map(person => person.handle), handles).length === handles.length;
        });
    }

    /**
     * Add a room to TeamworkChat and emit the appropriate events.
     *
     * @param {Room} room The room object.
     */
    addRoom(room) {
        // Listen to updates on the room object and proxy them through this instance
        room.on("message", this.emit.bind(this, "message", room));
        room.on("message:mention", this.emit.bind(this, "message:mention", room));
        room.on("updated", this.emit.bind(this, "room:updated", room));
        room.on("person:added", this.emit.bind(this, "room:person:added", room));
        room.on("person:removed", this.emit.bind(this, "room:person:removed", room));

        // Emit the new room event
        this.emit("room:new", room);

        logger.debug("new room");
        this.rooms.push(room);

        return room;
    }

    /**
     * Add multiple rooms.
     *
     * @param {Room[]} rooms
     */
    addRooms(rooms) {
        return rooms.map(room => this.addRoom(room));
    }

    /**
     * Save the room data from the API response to the appropriate room or create a new
     * room and add it if it does not exist.
     *
     * @param  {Object} rawRoom The room returned from the API.
     * @return {Room}           The saved or created room.
     */
    saveRoom(rawRoom) {
        let room = this.findRoomById(rawRoom.id);

        if(room) {
            room = room.update(rawRoom);

            if(rawRoom.people) {
                const people = rawRoom.people.map(person => this.savePerson(person));
                const addedPeople = difference(people, room.people);
                const removedPeople = difference(room.people, people);
                addedPeople.forEach(person => room.handleAddedPerson(person));
                removedPeople.forEach(person => room.handleRemovedPerson(person));
            }

            return room;
        } else {
            const details = omit(rawRoom, "people");
            const participants = rawRoom.people && rawRoom.people.map(person => this.savePerson(person));

            // Test if it's a direct conversation with the current user. There's sometimes a case where a
            // user can be in a direct conversation with themselves. In this case, we just say it's a normal room
            // because it's really an invalid state.
            if(participants && participants.length === 2 && participants.includes(this) && !participants.every(person => person === this)) {
                // If so, we can get the room attached to the user
                const [ directUser ] = without(participants, this);

                directUser.room.update(details);

                return directUser.room;
            } else {
                return this.addRoom(new Room(this.api, details, participants));
            }
        }
    }

    /**
     * Find a room by ID locally.
     *
     * @param  {Number} id The room's id.
     * @return {Room}
     */
    findRoomById(id) {
        return this.rooms.find(room => room.id === id);
    }

    /**
     * Find a room in memory by title.
     *
     * @param  {String|RegExp} title The exact title of the room or regex.
     * @return {Room}                The room, if any.
     */
    findRoomByTitle(title) {
        return this.rooms.find(room => {
            if(title instanceof RegExp) {
                return title.test(room.title);
            } else {
                return room.title === title;
            }
        });
    }

    /**
     * Get a room by ID. This attempts to find it in memory, if it does not exist,
     * it is loaded from the server and saved.
     *
     * @param  {Number}     id          The room ID.
     * @param  {Boolean}    cached      Optional, pick from the cache if room exists (default: true).
     * @return {Promise<Room>}          Resolves to the requested room.
     */
    getRoom(id, cached = true) {
        const room = this.findRoomById(id);

        if(!room || !cached) {
            return this.api.getRoom(id).then(room => this.saveRoom(room));
        } else return Promise.resolve(room);
    }

    /**
     * Get a room by it's title. WARNING: This method has to load
     *
     * @param  {String|RegExp} title The exact room title or a regex.
     * @return {Room}                The room, if any.
     */
    getRoomByTitle(title) {
        const room = this.findRoomByTitle(title);

        if(room) {
            return Promise.resolve(room);
        }

        return this.getRooms({ search: title }).then(() => {
            return this.findRoomByTitle(title);
        });
    }

    /**
     * Get rooms from the server and save in memory.
     *
     * @param  {Object} filter   The filter to pass to APIClient#getRooms.
     * @param  {Number} offset   The cursor offset.
     * @param  {Number} limit    The room count after the cursor.
     * @return {Promise<Room[]>} The list of rooms. The array also contains some extra properties:
     *                           offset, limit, total which are returned from the API.
     */
    getRooms(filter, offset, limit) {
        return this.api.getRooms(filter, offset, limit).then(res => {
            // First, we need to create the people. This creates the direct conversation
            // rooms with the current user which we will attempt to match later if we
            // come across later when a conversation contains on the current user and
            // another person.
            const people = uniqBy(flatten(res.conversations.map(({ people }) => people)), "id").map(this.savePerson.bind(this));

            // Next, we loop over all the conversations. If we come across a pair room containing
            // the current user (i.e. this.api), then we don't bother creating another room and just
            // update that direct room (attaches as Person.room).
            const conversations = res.conversations.map(this.saveRoom.bind(this));

            // Assign the return page details (limit, offset, total) to the returned array to
            // describe what results are returned.
            return Object.assign(conversations, res.meta.page);
        });
    }

    /**
     * Get all the rooms from the API and save in memory. WARNING: This makes a lot of API
     * calls if there is a lot of rooms so use sparingly. It is intentionally slow.
     *
     * @param  {Object} filter   The filter to pass to APIClient#getRooms.
     * @return {Promise<Room[]>} The list of rooms.
     */
    getAllRooms(filter) {
        return this.getRooms(filter).then(rooms => {
            const { limit, total } = rooms;
            const pages = range(limit, total, limit);

            return Promise.mapSeries(pages, offset => {
                return this.getRooms(filter, offset, limit).delay(1000);
            }).then(rest => {
                return rooms.concat(flatten(rest));
            })
        });
    }

    /**
     * Find a person in memory.
     *
     * @param  {Number} id The person's ID.
     * @return {Person}
     */
    findPersonById(id) {
        return this.room.findPersonById(id);
    }

    /**
     * Get a person by ID and save them.
     *
     * @param  {Number}  id     The person's ID.
     * @param  {Boolean} cached Whether or not to search cache first.
     * @return {Promise<Person>}
     */
    getPerson(id, cached = true) {
        const person = this.findPersonById(id);

        if(!person || !cached) {
            return this.api.getPerson(id).then(({ person }) => this.savePerson(person));
        } else return Promise.resolve(person);
    }

    /**
     * Find a person by a specific property. WARNING: If the person is not found in memory,
     * `getAllPeople` is called and ALL PEOPLE are loaded from the API. The requested user is
     * then plucked from the returned values.
     *
     * @param  {String} property The Person object's property to compare e.g. "id"
     * @param  {String} value    The value to compare Person[property]. If it matches, the person object is returned.
     * @return {Promise<Person>} The found person object.
     */
    getPersonBy(property, value) {
        const person = values(this.room.people).find(person => person[property] === value);

        // If we don't have a person, try load it from the API. Unfortunately, the API
        // doesn't seem to have an endpoint to get a user by API by handle so we get
        // all the people and pick from the returned list. The reason for the generic
        // function is so we don't have to duplicate this logic for each user property
        // we want to filter e.g. id, handle etc.
        if(!person) {
            logger.warn(
                `Warning: The Chat API does not currently support getting people directly by ${property}. ` +
                "To ensure a user is returned, all people must be fetched first and then the " +
                "users are filtered. This will run slower than expected."
            );

            // Get everyone and save them, pick the person.
            return this.getAllPeople().then(people => {
                const search = people.find(person => person[property] === value);

                if(!search) {
                    throw new Error(`No person found with ${property} "${value}".`);
                } else return search;
            });
        } else return Promise.resolve(person);
    }

    /**
     * Find or get a user by handle and save them.
     *
     * @param  {String} handle  The user's handle (without `@`)
     * @return {Promise<Person>}
     */
    getPersonByHandle(handle) {
        return this.getPersonBy("handle", handle);
    }

    /**
     * Get list of people and save them.
     *
     * @param  {Object} filter      Filter object passed to APIClient#getPeople.
     * @param  {Number} offset      The cursor offset.
     * @param  {Number} limit       The person count to return after the cursor.
     * @return {Promise<Person[]>}  The returned people list.
     */
    getPeople(filter, offset, limit) {
        return this.api.getPeople(filter, offset, limit).then(({ people }) => people.map(this.savePerson.bind(this)));
    }

    /**
     * Get all available people and save them.
     *
     * @return {Promise<Person[]>}
     */
    getAllPeople(filter) {
        // The default parameters for a call to `getPeople` returns all people. (Chat API defaults)
        return this.getPeople(filter);
    }

    /**
     * Save or create a person's data from the API.
     *
     * @param  {Object} rawPerson The person object from the API.
     * @return {Person}           The updated person.
     */
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

    /**
     * Add a person to global room.
     *
     * @param {Person} person
     */
    addPerson(person) {
        logger.debug("new person");

        // Proxy any received messages to the `message:direct` event
        person.on("message:received", this.emit.bind(this, "message:direct", person));

        return this.room.addPerson(person);
    }

    /**
     * Add multiple person objects at once.
     *
     * @param {Array<Person>} people
     */
    addPeople(people) {
        return this.room.addPeople(people);
    }

    /**
     * Get messages for user since now and `since`.
     *
     * @param  {Object} filter          Object containing filters.
     * @param  {Number} page            The message page (default: 1)
     * @param  {Number} pageSize        The amount of messages to return (default: 50)
     * @return {Promise<Message[]>}     The retrieved messages.
     */
    getMessages(filter, page, pageSize) {
        return this.api.getUserMessages(filter, page, pageSize).then(({ messages, pageInfo }) => {
            messages = messages.map(message => new Message(message));

            return Object.assign(messages, pageInfo);
        });
    }

    /**
     * Get all messages for a user since a specific timestamp.
     *
     * @param  {Object} filter          Object containing filters. See #getMessages.
     * @return {Promise<Message[]>}     The retrieved messages.
     */
    getAllMessages(filter) {
        // Get the first page to get the pagination details
        return this.getMessages(filter).then(messages => {
            if(messages.pages <= 1) {
                return messages;
            }

            // Get the remaining pages
            return Promise.mapSeries(range(2, messages.pages + 1), page => this.getMessages(filter, page)).then(pages => {
                return flatten([messages].concat(pages));
            });
        });
    }

    /**
     * Get updates since a specific timestamp.
     *
     * @param  {moment} since  The moment timestamp to get updates since.
     * @return {Promise<[]>}   Resolves to an array of [people, rooms, messages].
     */
    getUpdates(since) {
        // We should also hit `companies.json` after we reconnect for updates
        // on the companies however we don't use the data returned so we don't bother.
        const filter = { since };

        return Promise.all([
            this.getPeople(filter),
            this.getRooms(filter),
            this.getAllMessages(filter)
        ]);
    }

    /**
     * Override parent method and remove `api` key from details. This can
     * happen if we happen to serialize this person (i.e. TeamworkChat) and
     * then attempt to `addPerson`, it would override our API instance.
     *
     * @override
     */
    update(details) {
        return super.update(omit(details, "api"));
    }

    /**
     * Logout from the API and close the connection.
     *
     * @return {Promise} Resolves once logged out.
     */
    logout() {
        this.close();

        return this.api.logout();
    }

    /**
     * Close the connection to Teamwork Chat servers and logout.
     */
    close() {
        // Don't attempt to close the socket a second time
        if(this.forceClosed) {
            return;
        }

        logger.info("closing TeamworkChat connection");
        this.forceClosed = true;
        this.api.close();
    }

    /**
     * Connect or reconnect a closed socket (i.e. after calling `.close`).
     *
     * @return {[type]} [description]
     */
    connect() {
        this.forceClosed = false;

        if(this.api.connected)
            return Promise.resolve(this.api);

        return this.api.connect().then(api => {
            api.user = this.update(api.user);

            if(this.monitor.disconnects === 0) {
                // Monitor the first connection time
                this.monitor.initialConnectionTimestamp = moment();
            }
        });
    }

    /**
     * Override the default `emit` method to convert any `update` events to `user:update`
     * events. The `update` event happens in the parent Person class when the object is
     * update via the `update` method. Having an `update` event on this class doesn't make
     * sense so instead we convert updates to the currently logged in user as `user:update`.
     *
     * @override
     */
    emit(eventName, ...args) {
        // Convert Person "update" event (i.e. on the TeamworkChat instance) to "user:update".
        if(eventName === "update")
            eventName = "user:update";

        return super.emit(eventName, ...args);
    }

    /**
     * Serialize the current user to JSON but include the API details. Don't forget, this is also
     * a Person object.
     *
     * @return {Object}
     */
    toJSON() {
        return {
            ...super.toJSON(),
            api: this.api
        };
    }

    /**
     * Convert the TeamworkChat to a useful debug string for `util.inspect`.
     *
     * @return {String}
     */
    inspect() {
        return `Person{id = ${this.id}, current user, ${inspect(this.api)}}`;
    }

    /**
     * Login to the Teamwork Chat API, open a socket to the chat-server and complete
     * the authentication flow. The API Client takes care of pings and disconnection
     * so all you need to worry about is closing the instance via `close` when you are
     * done. Otherwise, you can use `withCredentials` to automatically clean up and
     * log the user out when complete (recommended). See TeamworkChat.withCredentials.
     *
     * @param  {String|Object}  installation  The installation URL.
     * @param  {String}         username      The username used to login to Teamwork.
     * @param  {String}         password      The password used to login to Teamwork (disposed after initial login request).
     * @param  {String}         socketServer  The socket server to target. Optional, defaults to env and config.json combo.
     * @return {Promise<TeamworkChat>}        An authorized and fully connected TeamworkChat instance.
     */
    static fromCredentials(installation, username, password, socketServer) {
        logger.info(`logging in with user ${username} to ${installation}.`, { installation, username, socketServer });
        return APIClient.loginWithCredentials(installation, username, password, socketServer).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }

    /**
     * Use TeamworkChat with a promise "disposer" pattern. This is like `fromCredentials` except
     * you pass it a callback where you use the first parameter, `chat` (the initialized TeamworkChat)
     * instance and return any promise. When that returned promises finishes execution (regardless of
     * outcome -- rejection or resolving), the `disposer` function is called and the socket to Chat is
     * closed. This allows the process to exit appropriately and ensures any open sockets are closed.
     * This will also *log the user out* when complete rendering the `tw-auth` token is useless.
     *
     * @param  {String|Object}  installation The installation URL.
     * @param  {String}         username     The username used to login to Teamwork.
     * @param  {String}         password     The password used to login to Teamwork (disposed after initial login request).
     * @param  {String}         socketServer The socket server to target. Optional, defaults to env and config.json combo.
     * @param  {Function}       callback     The callback (!) that has param `chat` TeamworkChat instance. This returns
     *                                       a promise that when complete, closes the connection to Teamwork.
     * @return {Promise}                     Resolves to nothing but ensures connection to Teamwork is closed fully.
     */
    static withCredentials(installation, username, password, socketServer, callback) {
        if(typeof socketServer === "function") {
            callback = socketServer;
            socketServer = undefined;
        }

        return Promise.using(TeamworkChat.fromCredentials(installation, username, password).disposer(chat => {
            return chat.logout();
        }), callback);
    }

    /**
     * Similar to `TeamworkChat.fromCredentials` except using a pre-existing auth key.
     *
     * @param  {String|Object}  installation The installation URL.
     * @param  {String}         auth         The user's auth key.
     * @param  {String}         socketServer The socket server to target. Optional, defaults to env and config.json combo.
     * @return {Promise<TeamworkChat>}       An authorized and fully connected TeamworkChat instance.
     */
    static fromAuth(installation, auth, socketServer) {
        return APIClient.loginWithAuth(installation, auth, socketServer).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }

    /**
     * The very same functionality as `TeamworkChat.withCredentials` except using an auth key.
     *
     * @param  {String|Object}  installation The installation URL.
     * @param  {String}         auth         The user's auth key.
     * @param  {String}         socketServer The socket server to target. Optional, defaults to env and config.json combo.
     * @param  {Function}       callback     The callback (!) that has param `chat` TeamworkChat instance. This returns
     *                                       a promise that when complete, closes the connection to Teamwork.
     * @return {Promise<TeamworkChat>}       An authorized and fully connected TeamworkChat instance.
     */
    static withAuth(installation, auth, socketServer, callback) {
        if(typeof socketServer === "function") {
            callback = socketServer;
            socketServer = undefined;
        }

        return Promise.using(TeamworkChat.fromAuth(installation, auth, socketServer).disposer(chat => {
            return chat.logout();
        }), callback);
    }

    /**
     * Similar to `TeamworkChat.fromCredentials` except using a Projects API key.
     *
     * @param  {String|Object}  installation The installation URL.
     * @param  {String}         key          The user's Projects "API Key".
     * @param  {String}         socketServer The socket server to target. Optional, defaults to env and config.json combo.
     * @return {Promise<TeamworkChat>}       An authorized and fully connected TeamworkChat instance.
     */
    static fromKey(installation, key, socketServer) {
        return APIClient.loginWithKey(installation, key, socketServer).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }

    /**
     * The very same functionality as `TeamworkChat.withCredentials` except using a Projects API key.
     *
     * @param  {String|Object}  installation The installation URL.
     * @param  {String}         key          The user's Projects "API Key".
     * @param  {String}         socketServer The socket server to target. Optional, defaults to env and config.json combo.
     * @param  {Function}       callback     The callback (!) that has param `chat` TeamworkChat instance. This returns
     *                                       a promise that when complete, closes the connection to Teamwork.
     * @return {Promise<TeamworkChat>}       An authorized and fully connected TeamworkChat instance.
     */
    static withKey(installation, key, socketServer, callback) {
        if(typeof socketServer === "function") {
            callback = socketServer;
            socketServer = undefined;
        }

        return Promise.using(TeamworkChat.fromKey(installation, key, socketServer).disposer(chat => {
            return chat.logout();
        }), callback);
    }

    /**
     * Login with an object that contains a combination of the following properties. It's essentially
     * a shortcut object for the `from*` methods.
     *
     *  * "installation", "key" - The installation and user's API key.
     *  * "installation", "username", "password" - The installation and user's username and password.
     *  * "installation", "token" - The installation and user's API token.
     *
     * @param  {Object} details Object containing the above keys.
     * @return {Promise<TeamworkChat>}  Resolves to an TeamworkChat instance.
     */
    static from(details) {
        return APIClient.from(details).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }
}