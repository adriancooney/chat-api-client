import APIClient from "../src/APIClient";

const INSTALLATION = "digitalcrew.teamwork.com";
const USERNAME = "adrian.cooney@teamwork.com";
const PASSWORD = "2+@b7oDjnR6r=Ghbh6Z";

describe("APIClient", () => {
    describe(".loginWithCredentials", function() {
        this.timeout(10000);
        it("should login correctly", () => {
            return APIClient.loginWithCredentials(INSTALLATION, USERNAME, PASSWORD);
        });
    });
});