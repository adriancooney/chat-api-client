import { inspect } from "util";
import Promise from "bluebird";
import moment from "moment";
import createDebug from "debug";
import { omit } from "lodash";
import EventEmitter from "./lib/EventEmitter";
import Room from "./Room";

const debug = createDebug("tw-chat:person");

/**
 * Person model.
 *
 * Events:
 *
 *  "updated": ({Person} person, {Object} changes)
 *  
 *      Emitted when the person object has been updated.
 *
 *  "message": ({Message} message)
 *
 *      Emitted when the direct conversation gets a new message. This is fired
 *      when the a message is sent or received.
 *
 *  "message:sent": ({Message} message)
 *
 *      Emitted when the currently logged in user sends a message to the current
 *      Person object.
 *
 *  "message:received": ({Message} message)
 *
 *      Emitted when the currently logged in user receives a message from the
 *      current Person object.
 * 
 */
export default class Person extends EventEmitter {
    /** @type {Number} The user's id. */
    id;

    /** @type {String} User's @ handle (e.g. "adrianc") *without* the `@` symbol. */
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

    /**
     * Create a new Person object.
     * 
     * @param  {APIClient}  api     The authorized API Client instance.
     * @param  {Object}     details Optional, the person details to pass to Person#Update.
     * @return {Person}
     */
    constructor(api, details) {
        super();
        
        this.api = api;

        // Node warns us that this is a potential "memory leak" however it is untrue (although it may be a sign of leaks to come).
        // Rooms (i.e. all the rooms) listen for the "updated" event on people so they can appropriately act on the information
        // and update the room however a person can be in many rooms. This presents a problem because hundreds of rooms
        // means hundreds of event listeners on a single person object. What do we do? Disable person update
        // notifications for rooms? Disable person update notifications for the logged in user on the rooms
        // and force the external to listen to TeamworkChat.on("user:updated")? Lazy bind event handlers to the
        // person objects until someone listens for a `person:updated` event? Anyway, for now, we're increasing
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

            // Proxy the message listener
            this.room.on("message", this.onMessage.bind(this));
        }

        if(details) {
            this.update(details);
        }
    }

    /**
     * Event Handler: When a room receives a message.
     * 
     * @param  {Message} message The new message object.
     */
    onMessage(message) {
        this.emit("message", message);

        const direction = message.userId === this.api.user.id ? "sent" : "received";
        this.emit(`message:${direction}`, message);
    }

    /**
     * Send a message to this person instance.
     * 
     * @param  {String} message     The string message.
     * @return {Promise<Message>}   Resolves to the sent message.
     */
    sendMessage(message) {
        return Promise.try(() => {
            if(!this.room.initialized) {
                return this.api.getPerson(this.id).then(({ person }) => {
                    this.update(person);
                });
            }
        }).then(() => {
            return this.room.sendMessage(message);
        });
    }

    /**
     * Update the current Person object.
     * 
     * @param  {Object} details Person details (from API).
     * @return {Person}         The current person instance.
     */
    update(details) {
        let update = {};

        if(details.id) update.id = parseInt(details.id);
        if(details.lastActivityAt) update.lastActivity = moment(details.lastActivityAt);

        update = Object.assign(omit(details, [
            "lastActivityAt",
            "roomId"
        ]), update);

        let person = Object.assign(this, update);
        this.emit("updated", person, update);

        // If we have a roomId, add it to the pair room
        if(details.roomId) {
            this.room.update({ id: details.roomId });
        }

        return person;
    }

    /**
     * Determine if a user has been mentioned in a message.
     * 
     * @param  {Message}  message The message object.
     * @return {Boolean}
     */
    isMentioned(message) {
        if(message.author.id === this.id) {
            // You can't be mentioned by yourself
            return false;
        }

        if(!this.handlerMatcher) {
            // Cache the regex
            this.handlerMatcher = new RegExp(`@${this.handle}`, "g");
        }

        // Test the message content
        return message.content.match(this.handlerMatcher);
    }

    /**
     * Serialize the Person.
     * 
     * @return {Object}
     */
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

    /**
     * Convert the Person to a string.
     * @return {String} e.g. `@adrianc`
     */
    toString() {
        return `@${this.handle}`;
    }

    /**
     * Convert Person object to useful debug string (`util.inspect`).
     * @return {String}
     */
    inspect() {
        return `Person{id = ${this.id}, @${this.handle}, "${this.firstName} ${this.lastName}", ${this.status}}`;
    }
}