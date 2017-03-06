import TeamworkAPIClient from "../../src/api";

const installation = "http://"

describe("TeamworkAPIClient", () => {
    describe(".from*", () => {
        it("should create a new Teamwork client", () => {
            return TeamworkAPIClient.fromAuth()
        });
    });
});