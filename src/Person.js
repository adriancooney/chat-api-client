import { inspect } from "util";
import Promise from "bluebird";
import Debug from "debug";
import Room from "./Room";

const debug = Debug("tw-chat:person");

export default class Person extends Room {
    constructor(api, details) {
        super(api);


        if(api.user) {
            super.addPerson(api.user);
        }

        this.update(details);
        super.addPerson(this);
    }

    sendMessage(message) {
        if(this.participants.length === 1)
            Promise.reject(new Error("Cannot send message to self!"));

        return super.sendMessage(message);
    }

    toString() {
        return `@${this.username}`;
    }

    update(details) {
        return Object.assign(this, details);
    }

    addPerson() {
        throw new Error("Cannot add another person to a pair room. Find or create new room with participants.");
    }

    [inspect.custom]() {
        return `Person[id = ${this.id}]`;
    }
}