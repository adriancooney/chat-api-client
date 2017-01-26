import { omit, values } from "lodash";
import APIClient from "./APIClient";
import Room from "./Room";
import Person from "./Person";

export default class TeamworkChat extends Person {
    constructor(api, user) {
        super(api, user);

        this.rooms = {};
    }

    static fromCredentials(installation, username, password) {
        return APIClient.loginWithCredentials(installation, username, password).then(api => {
            return new TeamworkChat(api, api.user);
        });
    }

    sendMessage() {
        throw new Error("Illegal operation: cannot send message without room.");
    }

    addRoom(room) {
        return this.rooms[room.id] = room;
    }

    getRoom(id) {
        return this.rooms[id];
    }

    saveRoom(rawRoom) {
        const room = this.getRoom(rawRoom.id);

        if(room) {
            return room.update(rawRoom);
        } else return this.addRoom(new Room(this.api, rawRoom));
    }

    getRooms(offset, limit) {
        return this.api.getRooms(offset, limit).then(res => {
            const conversations = res.conversations.map(conversation => {
                const room = this.saveRoom({
                    ...omit(conversation, "people")
                });

                room.addPeople(conversation.people.map(this.savePerson.bind(this)));

                return room;
            });

            return Object.assign(conversations, res.meta.page);
        });
    }
    
    getPerson(id) {
        return Room.prototype.getPerson.call(this, id);
    }

    getAllRooms() {
        return this.getRooms().then(rooms => {
            return [rooms, this.getRooms(rooms.limit, rooms.total - rooms.limit)];
        }).spread((rooms, rest) => {
            return rooms.concat(rest);
        });
    }

    savePerson(rawPerson) {
        let person = this.getPerson(rawPerson.id);

        if(person) {
            if(!(person instanceof Person)) {
                // This case happens because of this class is technically a room
                // and further up the prototype chain, the API user gets added as
                // a person from the Room class.
                person = new Person(this.api, person);
            }

            return person.update(rawPerson);
        } else return this.addPerson(new Person(this.api, rawPerson));
    }

    addPerson(person) {
        return Room.prototype.addPerson.call(this, person);
    }

    addPeople(people) {
        return Room.prototype.addPeople.call(this, people);
    }

    getAllPeople() {
        return values(this.people);
    }
}