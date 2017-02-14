import assert from "assert";
import Promise from "bluebird";
import { 
    createFrame, 
    createMessageFrame, 
    createRoom, 
    createPerson,
    expectRequest,
    devTeamworkChat, 
    localTeamworkChat 
} from "./fixture";
import TeamworkChat, {
    APIClient, Person, Room, Message
} from "..";

describe("TeamworkChat", function() {
    describe("instance methods", () => {
        let chat;
        beforeEach(async () => {
            chat = await devTeamworkChat();
        });

        describe("#getPersonByHandle", () => {
            it("should return a person by handle", async () => {
                const peter = await chat.getPersonByHandle("peter");

                assert(peter instanceof Person);
                assert.equal(peter.handle, "peter");
            });

            it("should return the same person object for different calls", async () => {
                const peter1 = await chat.getPersonByHandle("peter");
                const peter2 = await chat.getPersonByHandle("peter");

                assert.equal(peter1, peter2, "Person objects returned are not the same.");
            });
        });

        describe("#getRoomForHandles", () => {
            it("should return a room for handles", async () => {
                let room = await chat.getRoomForHandles(["peter", "testUser2"]);

                assert(room instanceof Room);
            });

            it("should return a pair room for a single handle", async () => {
                let room = await chat.getRoomForHandles(["peter"]);
                let peter = await chat.getPersonByHandle("peter");

                assert.equal(room, peter.room);
            });
        });
    });

    describe("events", function() {
        this.timeout(0);

        let chat;
        beforeEach(async () => {
            chat = await localTeamworkChat();
        });

        describe("socket event: close", () => {
            it("should reconnect on close", done => {
                chat.on("error", done);

                chat.on("disconnect", () => {
                    chat.on("reconnect", () => {
                        done();
                    });
                });

                chat.api.socket.close();
            });
        });

        describe("chat event: room.message.created", () => {
            it("should send the message to the appropriate, existing room", done => {
                chat.on("error", done);

                const room = new Room(chat.api, { id: 1 });
                chat.addRoom(room);

                chat.api.emit("frame", createMessageFrame());

                room.on("message", incoming => {
                    assert(incoming instanceof Message);
                    assert.equal(incoming.id, 52);
                    done();
                });
            });
        });

        describe("chat event: user.modified", () => {
            it("it should update the user appropriately", done => {
                chat.on("error", done);

                chat.getPersonByHandle("peter").then(peter => {
                    peter.on("update", () => {
                        assert.equal(peter.status, "online");
                        done();
                    });

                    chat.api.emit("frame", createFrame("user.modified", {
                        userId: peter.id,
                        key: "status",
                        value: "online"
                    }));
                });
            });
        });

        describe("chat event: user.updated", () => {
            it.only("should directly query the API when a user is updated", done => {
                chat.on("error", done);

                let restore = expectRequest(/\/people.json/, { people: [createPerson()] });

                chat.getPersonByHandle("developers").then(peter => {
                    restore();

                    restore = expectRequest(/people\/(\d+)\.json/, $1 => ({
                        person: createPerson({ id: parseInt($1) })
                    }));

                    chat.api.emit("frame", createFrame("user.updated", {
                        id: peter.id
                    }));

                    chat.on("person:update", person => {
                        assert.equal(person.id, peter.id);
                        restore();
                        done();
                    });
                });
            });
        });
    });

    describe("flows", () => {
       let chat;
        beforeEach(async () => {
            chat = await devTeamworkChat();
        });

        describe("get people by handle and send message", () => {
            it("should send a private message when you only want one user", async () => {
                const peter = await chat.getPersonByHandle("peter");
                // const room = await chat.getRoomForHandles(["peter"]);
                console.log(peter.roomId);

                // await room.sendMessage("room");
            });
        });
    });
});