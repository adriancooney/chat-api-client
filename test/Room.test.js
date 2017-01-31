import assert from "assert";
import Promise from "bluebird";
import { localTeamworkChat } from "./";
import TeamworkChat, {
    APIClient, Person, Room, Message
} from "..";

describe("Room", function() {
    describe("instance methods", () => {
        let chat;
        beforeEach(async () => {
            chat = await localTeamworkChat();
        });

        describe("#sendMessage", () => {
            it("should create (or get) the room if uninitialized", async () => {
                let room = await chat.getRoomForHandles(["peter", "testUser2"]);

                await room.sendMessage("howya lads");
            });
        });
    });
});