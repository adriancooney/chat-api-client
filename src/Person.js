import { inspect } from "util";
import Promise from "bluebird";
import moment from "moment";
import { omit } from "lodash";
import Debug from "debug";
import Room from "./Room";

const debug = Debug("tw-chat:person");

export default class Person {
    id;

    /** @type {String} User's @ handle. e.g. @adrianc*/
    handle;

    /** @type {String} User's first name. */
    firstName;

    /** @type {String} User's last name. */
    lastName;

    /** @type {String} User's email. */
    email;

    /** @type {moment} Date of user's last activity. */
    lastActivity = null;

    constructor(api, details) {
        this.api = api;
        this.room = new Room(api);

        this.update(details);

        // There's a single special case where the TeamworkChat is also a "Person"
        // in that it's a logged in user. It's room is the global root room and
        // is essentially just a people manager, all message sending features are
        // disabled. We don't bother adding to them if `this` person is the single
        // `TeamworkChat` instance.
        if(this.constructor.name == "TeamworkChat")
            return;

        this.room.addPerson(api.user);
        this.room.addPerson(this);
    }

    sendMessage(message) {
        if(this.peopleCount === 1)
            Promise.reject(new Error("Cannot send message to self!"));

        return Promise.try(() => {
            if(!this.room.initialized) {
                return this.api.getRoom(this.roomId).then(({ room }) => {
                    this.room.update(room)
                });
            }
        }).then(() => {
            return this.room.sendMessage(message);
        });
    }

    update(details) {
        return Object.assign(this, omit(details, [
            "lastActivityAt"
        ]), {
            // Convert "lastActivityAt" to moment object and put in "lastActivity" property
            lastActivity: details.lastActivityAt ? moment(details.lastActivityAt) : null,
            id: parseInt(details.id)
        });
    }

    addPerson() {
        throw new Error("Cannot add another person to a pair room. Find or create new room with participants.");
    }

    get lastSeen() {
        return this.lastActivity ? this.lastActivity.fromNow() : "unknown";
    }

    toString() {
        return `@${this.handle}`;
    }

    inspect() {
        return `Person[id = ${this.id}, @${this.handle}, "${this.firstName} ${this.lastName}", ${this.status}, last seen: ${this.lastSeen}]`;
    }
}