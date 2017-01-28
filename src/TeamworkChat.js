import { inspect } from "util";
import { omit, values, flatten, without } from "lodash";
import APIClient from "./APIClient";
import Room from "./Room";
import Person from "./Person";
import Message from "./Message";

export default class TeamworkChat extends Person {
    constructor(api, user) {
        super(api, user);

        this.rooms = {};

        this.api.user = this;
        this.room.addPerson(this);
        this.api.on("frame", this.onFrame);
        this.api.on("close", this.onDisconnect);
    }

    static fromCredentials(installation, username, password) {
        return APIClient.loginWithCredentials(installation, username, password).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }

    onDisconnect() {

    }

    onFrame(frame) {
        switch(frame.name) {
            case "room.message.created":
                const message = new Message(frame.contents);
                this.emit("message", message);
                this.emit("message:new", message);
            break;
        }
    }

    sendMessage() {
        throw new Error("Illegal operation: cannot send to self.");
    }

    addRoom(room) {
        return this.rooms[room.id] = room;
    }

    getRoom(id) {
        return this.rooms[id];
    }

    saveRoom(rawRoom) {
        let room = this.getRoom(rawRoom.id);

        if(room) {
            return room.update(rawRoom);
        } else {
            const details = omit(rawRoom, "people");
            const participants = rawRoom.people.map(person => this.getPersonById(person.id));

            // Test if it's a direct conversation with the current user
            if(participants.length === 2 && participants.includes(this)) {
                const [ directUser ] = without(participants, this);

                directUser.room.update(details);

                return directUser.room;
            } else {
                return this.addRoom(new Room(this.api, details, participants));
            }
        }
    }

    getRooms(offset, limit) {
        return this.api.getRooms(offset, limit).then(res => {
            // First, we need to create the people. This creates the direct conversation
            // rooms with the current user which we will attempt to match later if we
            // come across later when a conversation contains on the current user and
            // another person.
            const people = flatten(res.conversations.map(({ people }) => people)).map(this.savePerson.bind(this));

            // Next, we loop over all the conversations. If we come across a pair room containing
            // the current user (i.e. this.api), then we don't bother creating another room and just
            // update that room.
            const conversations = res.conversations.map(this.saveRoom.bind(this));

            return Object.assign(conversations, res.meta.page);
        });
    }

    getAllRooms() {
        return this.getRooms().then(rooms => {
            return [rooms, this.getRooms(rooms.limit, rooms.total - rooms.limit)];
        }).spread((rooms, rest) => {
            return rooms.concat(rest);
        });
    }
    
    getPerson(id) {
        return this.room.getPerson(id);
    }

    getPersonById(id) {
        return this.room.getPersonById(id);
    }

    getPersonByHandle(handle) {
        return this.room.getPersonByHandle(handle).then(person => {
            // If we don't have a person, try load it from the API. Unfortunately, the API
            // doesn't seem to have an endpoint to get a user by API by handle so we get
            // all the people and pick from the returned list.
            if(!person) {
                console.warn(
                    "Warning: The Chat API does not currently support getting people directly by handle. " +
                    "To ensure a user is returned, all people must be fetched first and then the " +
                    "user with that handle is picked. This will run slower than expected."
                );

                // Get everyone and save them, pick the person.
                return this.api.getPeople().then(({ people }) => people.map(this.savePerson.bind(this))).then(people => {
                    const search = people.find(person => person.handle === handle);

                    if(!search) {
                        throw new Error(`No person found with handle @${handle}.`);
                    } else return search;
                });
            } else return person;
        });
    }

    savePerson(rawPerson) {
        let person = this.room.getPersonById(rawPerson.id);

        if(person) {
            return person.update(rawPerson);
        } else {
            person = new Person(this.api, rawPerson);
            this.addRoom(person.room);
            return this.room.addPerson(person);
        }
    }

    addPerson(person) {
        return this.room.addPerson(person);
    }

    addPeople(people) {
        return this.room.addPeople(people);
    }

    getAllPeople() {
        return values(this.room.people);
    }

    inspect() {
        return `TeamworkChat[current user, ${inspect(this.api)}]`;
    }
}