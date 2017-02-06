import { inspect } from "util";
import Promise from "bluebird";
import moment from "moment";
import { omit } from "lodash";
import Debug from "debug";
import EventEmitter from "./lib/EventEmitter";
import Room from "./Room";

const debug = Debug("tw-chat:person");

export default class Person extends EventEmitter {
    /** @type {Number} The user's id. */
    id;

    /** @type {String} User's @ handle. e.g. @adrianc*/
    handle;

    /** @type {String} User's first name. */
    firstName;

    /** @type {String} User's last name. */
    lastName;

    /** @type {String} User's email. */
    email;

    /** @type {String} The user's title e.g. "Developer" or "Accounts Manager" */
    title;

    /** @type {moment} Date of user's last activity with the currently logged in user. */
    lastActivity = null;

    constructor(api, details) {
        super();
        
        this.api = api;

        // Node warns us that this is a potential "memory leak" however it is untrue (although it may be a sign of leaks to come).
        // Rooms (i.e. all the rooms) listen for the "update" event on people so they can appropriately act on the information
        // and update the room however a person can be in many rooms. This presents a problem because hundreds of rooms
        // means hundreds of event listeners on a single person object. What do we do? Disable person update
        // notifications for rooms? Disable person update notifications for the logged in user on the rooms
        // and force the external to listen to TeamworkChat.on("user:update")? Lazy bind event handlers to the
        // person objects until someone listens for a `person:update` event? Anyway, for now, we're increasing
        // the maxEventListener size to something huge for these Person emitters only but we will have to revisit this.
        this.setMaxListeners(1000);

        // There's a single special case where the TeamworkChat is also a "Person"
        // in that it's a logged in user. It's room is the global root room and
        // is essentially just a people manager, all message sending features are
        // disabled. We don't bother adding to them if `this` person is the single
        // `TeamworkChat` instance.
        if(this.constructor.name !== "TeamworkChat") {
            this.room = new Room(api);
            this.room.addPerson(api.user);
            this.room.addPerson(this);
        } else {
            this.room = new Room(api, { id: "root" });
        }

        if(details) {
            this.update(details);
        }
    }

    sendMessage(message) {
        if(this.peopleCount === 1)
            Promise.reject(new Error("Cannot send message to self!"));

        return Promise.try(() => {
            if(!this.room.initialized && this.roomId) {
                return this.api.getRoom(this.roomId).then(({ room }) => {
                    this.room.update(omit(room, "people"))
                });
            }
        }).then(() => {
            return this.room.sendMessage(message);
        });
    }

    update(details) {
        let update = {};

        if(details.id) update.id = parseInt(details.id);
        if(details.lastActivityAt) update.lastActivity = moment(details.lastActivityAt);

        update = Object.assign(omit(details, [
            "lastActivityAt",
            "roomId"
        ]), update);

        let person = Object.assign(this, update);
        this.emit("update", person, update);

        // If we have a roomId, add it to the pair room
        if(details.roomId) {
            this.room.update({ id: details.roomId });
        }

        return person;
    }

    get lastSeen() {
        return this.lastActivity ? this.lastActivity.fromNow() : "unknown";
    }

    toJSON() {
        return {
            id: this.id,
            handle: this.handle,
            firstName: this.firstName,
            lastName: this.lastName,
            email: this.email,
            lastActivity: this.lastActivity
        };
    }

    toString() {
        return `@${this.handle}`;
    }

    inspect() {
        return `Person{id = ${this.id}, @${this.handle}, "${this.firstName} ${this.lastName}", ${this.status}}`;
    }
}