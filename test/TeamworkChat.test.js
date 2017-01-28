import TeamworkChat from "../src/TeamworkChat";

const INSTALLATION = {
    protocol: "http:",
    hostname: "sunbeam.teamwork.dev",
    port: 5000
};

const USERNAME = "donalin+dev1@gmail.com";
const PASSWORD = "test";

describe("TeamworkChat", function() {
    this.timeout(0);
    describe(".withCredentials", () => {
        it("should create a new TeamworkChat correctly", async () => {
            let chat = await TeamworkChat.fromCredentials(INSTALLATION, USERNAME, PASSWORD);
            // let rooms = await chat.getRooms();
            let peter = await chat.getPersonByHandle("peter");
            console.log(peter, peter.room);
            await peter.sendMessage("howya ");

            console.log(chat.rooms);
        });
    });
});