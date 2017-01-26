import TeamworkChat from "../src/TeamworkChat";

const INSTALLATION = {
    protocol: "http:",
    hostname: "sunbeam.teamwork.dev",
    port: 5000
};

const USERNAME = "donalin+dev1@gmail.com";
const PASSWORD = "test";

describe("TeamworkChat", function() {
    this.timeout(10000);

    describe("withCredentials", () => {
        it("should create a new TeamworkChat correctly", () => {
            return TeamworkChat.fromCredentials(INSTALLATION, USERNAME, PASSWORD).then(chat => {
                return [chat, chat.getRooms()];
            }).spread((chat, [ room ]) => {
                return room.sendMessage("well lad");
            });
        });
    });
});