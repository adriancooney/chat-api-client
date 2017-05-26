import { inspect } from "util";
import Promise from "bluebird";
import moment from "moment";
import createDebug from "debug";
import { values, size, omit, last, without } from "lodash";
import EventEmitter from "./lib/EventEmitter";
import Message from "./Message";

const debug = createDebug("tw-chat:room");

const MAX_MESSAGE_RETENTION = 50;

/**
 * The Room model.
 *
 * Events:
 *
 *      "updated": ({Object} changes)
 *
 *          Emitted when the room is updated.
 *
 *      "person:new": ({Person} person)
 *
 *          Emitted when a new person is added to the room.
 *
 *      "person:updated": ({Person} person, {Object} changes)
 *
 *          Emitted when a person in the room changes.
 *
 *      "message": ({Message} message)
 *
 *          Emitted when the room receives a new message.
 *
 *      "message:received": ({Message} message)
 *
 *          Emitted when a room receives a message that is not from the
 *          currently logged in user.
 *
 */
export default class Room extends EventEmitter {
    /** @type {Number} The room ID. */
    id;

    /** @type {String} The room type e.g. "pair", "private" */
    type;

    /** @type {String} The room title. */
    title;

    /** @type {String} Room status e.g. "active" */
    status;

    /** @type {Number} The total number of unread message. */
    unreadCount;

    /** @type {Number} The number of important unread messages. */
    importantUnreadCount;

    /** @type {moment} The timestamp of the last activity in the room. */
    lastActivityAt;

    /** @type {moment} The timestamp the room was last viewed. */
    lastViewedAt;

    /** @type {moment} The timestamp the room was last update (?) */
    updatedAt;

    /** @type {moment} The timestamp of when the room was created. */
    createdAt;

    /** @type {Number} The ID of the person who created the room. */
    creatorId;

    /** @type {Array} The messages store for this room. */
    messages = [];

    /** @type {Array} The people in the room. */
    people = [];

    /**
     * Create a new Room.
     *
     * @param  {APIClient}  api          Authorized APIClient instance.
     * @param  {Object}     details      Optional, room details from API.
     * @param  {Person[]}   participants Optional, list of room particpants.
     * @return {Room}
     */
    constructor(api, details, participants) {
        super();

        this.api = api;

        if(details)
            this.update(details);

        if(participants)
            this.addPeople(participants);
    }

    /**
     * Update the room object.
     *
     * @param  {Object} details The details to update (usually API response).
     * @return {Room}           The updated room object.
     */
    update(details) {
        const timestamps = ["lastActivityAt", "lastViewedAt", "updatedAt", "createdAt"].reduce((up, ts) => {
            if(details[ts]) {
                up[ts] = moment(details[ts]);
            }

            return up;
        }, {});

        Object.assign(this, omit(details, "people"), timestamps);

        this.emit("updated", details);

        return this;
    }

    /**
     * Update the title of the room with the API.
     *
     * @param  {String}     title  The new title.
     * @return {Promise<Room>}     The updated room.
     */
    updateTitle(title) {
        return this.api.updateRoomTitle(this.id, title).then(() => {
            return this.update({ title });
        });
    }

    /**
     * Find a person in memory by ID.
     *
     * @param  {Number} id The person's ID.
     * @return {Person}
     */
    findPersonById(id) {
        return this.people.find(person => person.id === id);
    }

    /**
     * Add a new person to the room.
     *
     * @param  {Person} person  The person to add.
     * @return {Person}         The added person.
     */
    addPerson(person) {
        person.on("updated", this.emit.bind(this, "person:updated"));
        this.emit("person:new", person);
        this.people.push(person);
        return person;
    }

    /**
     * Add multiple person objects to a room.
     *
     * @param  {Person[]} people  Array of person objects.
     * @return {Person[]}         The added person objects.
     */
    addPeople(people) {
        return people.map(this.addPerson.bind(this));
    }

    /**
     * Delete a person from the room.
     *
     * @param  {Person} person The person to delete.
     * @return {Person[]}      The deleted person.
     */
    deletePerson(person) {
        this.emit("person:deleted", person);
        this.people = without(this.people, person);
        return person;
    }

    /**
     * Handle a new person to the room.
     *
     * @param  {Person} person The new person.
     * @return {Person}        The added person.
     */
    handleAddedPerson(person) {
        this.emit("person:added", person);
        return this.addPerson(person);
    }

    /**
     * Handle a new person to the room.
     *
     * @param  {Person} person The new person.
     * @return {Person}        The added person.
     */
    handleRemovedPerson(person) {
        this.emit("person:removed", person);
        return this.deletePerson(person);
    }

    /**
     * Event Handler: When a new message is sent to the room.
     *
     * @param  {Message} message The new message object.
     */
    handleMessage(message) {
        message = this.saveMessage(message);

        this.emit("message", message);

        if(message.author !== this.api.user) {
            this.emit("message:received", message);
        }

        // Handle mentions
        if(this.api.user.isMentioned(message)) {
            this.emit("message:mention", message);
        }
    }

    /**
     * Add a new message to the room.
     *
     * @param  {Message} message  The new message.
     * @return {Message}          The newly added message.
     */
    addMessage(message) {
        // Only hold the last MAX_MESSAGE_RETENTION message
        if(this.messages.length >= MAX_MESSAGE_RETENTION) {
            this.messages.shift();
        }

        this.messages.push(message);

        return message;
    }

    /**
     * Get and save messages for a room.
     *
     * @return {Promise<Message[]>} The message objects from the API.
     */
    getMessages() {
        if(!this.initialized)
            return Promise.reject(new Error("Unable to get messages for uninitialized room."));

        return this.api.getMessages(this.id).then(({ messages }) => {
            return messages.map(message => this.saveMessage(message));
        });
    }

    /**
     * Save or create a message to the room.
     *
     * @param  {Object} rawMessage The raw message returned from the API.
     * @return {Message}           The newly created (or saved) message object.
     */
    saveMessage(rawMessage) {
        const message = this.findMessageById(rawMessage.id);
        const author = this.findPersonById(rawMessage.userId);
        const details = {
            ...rawMessage,
            room: this,
            author: author || rawMessage.userId
        };

        if(message) {
            return message.update(details);
        } else {
            return this.addMessage(new Message(details));
        }
    }

    /**
     * Delete the room from the API.
     * @return {Promise} Resolves when the room is deleted.
     */
    delete() {
        return this.api.deleteRoom(this.id).then(() => {
            this.emit("delete");
        });
    }

    /**
     * Find a message in memory by ID.
     *
     * @param  {Number} id  The message ID.
     * @return {Message}    The found message object.
     */
    findMessageById(id) {
        return this.messages.find(message => message.id === id);
    }

    /**
     * Send a message to the room (or create it if uninitialized).
     *
     * There's an unfortunate case where this function could be used (and is, see tw-chat-message)
     * to send a message before (any or) all the rooms are loaded into memory. In that case, this
     * function will *always* create a new room for the message because it doesn't know what room
     * to send it to otherwise. The API really should know to put the message into the pair
     * conversation but it doesn't look like it does.
     *
     * @param  {String}  message     Message content.
     * @return {Promise<Message>}    Resolves to the sent message.
     */
    sendMessage(message) {
        message = new Message(message);

        if(!this.initialized) {
            const participants = this.people
                .filter(person => person.id !== this.api.user.id)
                .map(person => person.handle);

            return this.api.createRoom(participants, message.content).then(({ roomId }) => {
                return this.api.getRoom(roomId);
            }).then(({ room }) => {
                this.update(omit(room, "people"));

                // Unfortunately the API doesn't return the created message when it's a new room
                // so we have to load messages and return the most recent.
                return this.getMessages();
            }).then(last);
        } else {
            return this.api.sendMessage(this.id, message.content).then(message => {
                return this.saveMessage(message);
            });
        }
    }

    /**
     * Tell the server the currently logged in user is active in this room.
     *
     * @return {Promse} Resolves once the frame is sent (there is no ack/fire and forget).
     */
    activate() {
        return this.api.activateRoom(this.id);
    }

    /**
     * Send the `typing` event as the currently logged in user to the current room.
     *
     * @param  {Boolean} isTyping  Whether or not the user is typing.
     * @return {Promise}           Resolves when the frame is sent (again, no ack of the frame).
     */
    typing(isTyping = true) {
        return this.api.typing(isTyping, this.id);
    }

    /**
     * Determine whether the current room instance has been initialized. "Initialized" simply
     * means has the room an ID or not.
     *
     * @return {Boolean}
     */
    get initialized() {
        return !!this.id;
    }

    /**
     * Convert the room object to useful debuggable object (`util.inspect`).
     *
     * @return {String}
     */
    inspect() {
        return `Room{id = ${this.id}, [ ${this.people.map(person => `@${person.handle}`).join(", ")} ], messageCount = ${this.messages.length}}`;
    }

    /**
     * Serialize the room object.
     *
     * @return {Object}
     */
    toJSON() {
        return {
            people: this.people,
            messages: this.messages,
            id: this.id,
            type: this.type,
            title: this.title,
            status: this.status,
            lastActivityAt: this.lastActivityAt,
            lastViewedAt: this.lastViewedAt,
            updatedAt: this.updatedAt,
            creatorId: this.creatorId,
            createdAt: this.createdAt
        };
    }
}