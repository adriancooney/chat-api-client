import { inspect } from "util";
import Promise from "bluebird";
import Debug from "debug";
import { values, size, omit } from "lodash";
import EventEmitter from "./lib/EventEmitter";
import Message from "./Message";

const debug = Debug("tw-chat:room");

export default class Room extends EventEmitter {
    /** @type {Array} The messages store for this room. */
    messages = [];

    constructor(api, details, participants) {
        super();
        
        this.api = api;
        this.people = {};

        this.update(details);

        if(participants)
            this.addPeople(participants);
    }

    update(details) {
        let room = Object.assign(this, details);
        this.emit("update", room);
        return room;
    }

    getPerson(id) {
        return Promise.resolve(this.findPersonById(id));
    }

    findPersonById(id) {
        return this.people[id];
    }

    getPersonByHandle(handle) {
        return Promise.resolve(values(this.people).find(person => person.handle === handle));
    }

    addPerson(person) {
        console.log("Adding person", this, person);

        person.on("update", this.emit.bind(this, "person:update"));
        this.emit("person:new", person);
        return this.people[person.id] = person;
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

        if(message) {
            return message.update(rawMessage);
        } else {
            return this.addMessage(new Message(rawMessage));
        }
    }

    findMessageById(id) {
        return this.messages.find(message => message.id === id);
    }

    sendMessage(message, forceCreate = true) {
        if(!this.initialized && !forceCreate) 
            return Promise.reject(new Error("Illegal operation: Room must be initialized before attempting to send message."));

        message = new Message(message);

        if(!this.initialized) {
            return this.api.createRoom(values(this.people).map(person => person.handle), message.content).then(({ roomId }) => {
                return this.api.getRoom(roomId);
            }).then(({ room }) => {
                this.update(omit(room, "people"));

                return this.getMessages();
            }).then(([ initialMessage ]) => initialMessage);
        } else {
            return this.api.sendMessage(this.id, message.content).then(message => {
                // In the case where it's not initialized and we create the room, we pass a message 
                // object and not a `rawMessage` as `saveMessage` expects. This is due to the fact that 
                return this.saveMessage(message);
            });
        }
    }

    get initialized() {
        return !!this.id;
    }

    get isDirectConversation() {
        return size(this.people) === 2 && values(this.people).includes(this.api);
    }

    get peopleCount() {
        return size(this.people);
    }

    inspect() {
        return `Room{id = ${this.id}, [ ${values(this.people).map(person => `@${person.handle}`).join(", ")} ], messageCount = ${this.messages.length}}`;
    }

    toJSON() {
        return {
            people: values(this.people),
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