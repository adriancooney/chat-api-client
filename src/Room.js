import { inspect } from "util";
import Promise from "bluebird";
import createDebug from "debug";
import { values, size, omit, last } from "lodash";
import EventEmitter from "./lib/EventEmitter";
import Message from "./Message";

const debug = createDebug("tw-chat:room");

export default class Room extends EventEmitter {
    /** @type {Array} The messages store for this room. */
    messages = [];

    /** @type {Array} The people in the room. */
    people = [];

    constructor(api, details, participants) {
        super();
        
        this.api = api;

        if(details)
            this.update(details);

        if(participants)
            this.addPeople(participants);
    }

    update(details) {
        debug("updating room", this.toJSON(), details);
        let room = Object.assign(this, details);
        this.emit("update", room);
        return room;
    }

    findPeople() {
        return this.people;
    }

    getPerson(id) {
        return Promise.resolve(this.findPersonById(id));
    }

    findPersonById(id) {
        return this.people.find(person => person.id === id);
    }

    getPersonByHandle(handle) {
        return Promise.resolve(this.people.find(person => person.handle === handle));
    }

    addPerson(person) {
        person.on("update", this.emit.bind(this, "person:update"));
        this.emit("person:new", person);
        this.people.push(person);
        return person;
    }

    addPeople(people) {
        return people.forEach(this.addPerson.bind(this));
    }

    handleMessage(message) {
        return this.saveMessage(message);
    }

    addMessage(message) {
        this.messages.push(message);
        this.emit("message", message);
        return message;
    }

    getMessages() {
        if(!this.initialized)
            return Promise.reject(new Error("Unable to get messages for uninitialized room."));

        return this.api.getMessages(this.id).then(({ messages }) => {
            return messages.map(this.saveMessage.bind(this));
        });
    }

    saveMessage(rawMessage) {
        const message = this.findMessageById(rawMessage.id);
        const author = this.findPersonById(rawMessage.userId);
        const details = {
            ...rawMessage,
            author
        };

        if(message) {
            return message.update(details);
        } else {
            return this.addMessage(new Message(details));
        }
    }

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
     * @return {Promise}              
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
            }).then(messages => last(messages));
        } else {
            return this.api.sendMessage(this.id, message.content).then(message => { 
                return this.saveMessage(message);
            });
        }
    }

    activate() {
        return this.api.activateRoom(this.id);
    }

    typing(status = true) {
        return this.api.typing(status, this.id);
    }

    get initialized() {
        return !!this.id;
    }

    get isDirectConversation() {
        return size(this.people) === 2 && this.people.includes(this.api);
    }

    get peopleCount() {
        return size(this.people);
    }

    inspect() {
        return `Room{id = ${this.id}, [ ${this.people.map(person => `@${person.handle}`).join(", ")} ], messageCount = ${this.messages.length}}`;
    }

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