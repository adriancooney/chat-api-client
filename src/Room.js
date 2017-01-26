import { inspect } from "util";
import { EventEmitter } from "events";
import Debug from "debug";
import Readable from "stream";
import Message from "./Message";

const debug = Debug("tw-chat:room");

export default class Room extends EventEmitter {
    constructor(api, details) {
        super();
        
        this.api = api;
        this.people = {};

        this.update(details);
    }

    sendMessage(message) {
        return this.api.sendMessage(this, new Message(message));
    }

    isConversation() {
        return this.participants.length === 2;
    }

    update(details) {
        return Object.assign(this, details);
    }

    getPerson(id) {
        return this.people[id];
    }

    addPerson(person) {
        return this.people[person.id] = person;
    }

    addPeople(people) {
        return people.forEach(this.addPerson.bind(this));
    }

    [inspect.custom]() {
        return `Room[id = ${this.id}]`;
    }
}