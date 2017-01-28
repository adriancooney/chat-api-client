import { inspect } from "util";
import { EventEmitter } from "events";
import Promise from "bluebird";
import Debug from "debug";
import { values, size } from "lodash";
import Message from "./Message";

const debug = Debug("tw-chat:room");

export default class Room extends EventEmitter {
    constructor(api, details, participants) {
        super();
        
        this.api = api;
        this.people = {};

        this.update(details);

        if(participants)
            this.addPeople(participants);
    }

    sendMessage(message) {
        if(!this.initialized)
            throw new Error("Illegal operation: Room must be initialized before attempting to send message.");

        return this.api.sendMessage(this.id, (new Message(message)).content);
    }

    isConversation() {
        return this.participants.length === 2;
    }

    update(details) {
        return Object.assign(this, details);
    }

    getPerson(id) {
        return Promise.resolve(this.getPersonById(id));
    }

    getPersonById(id) {
        return this.people[id];
    }

    getPersonByHandle(handle) {
        return Promise.resolve(values(this.people).find(person => person.handle === handle));
    }

    addPerson(person) {
        return this.people[person.id] = person;
    }

    addPeople(people) {
        return people.forEach(this.addPerson.bind(this));
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
        return `Room[id = ${this.id}, { ${values(this.people).map(person => inspect(person)).join(", ")} }]`;
    }
}