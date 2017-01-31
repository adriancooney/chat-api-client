import assert from "assert";
import APIClient from "../src/APIClient";
import { INSTALLATION, USERNAME, PASSWORD, localAPIClient } from "./";

describe("APIClient", () => {
    describe("static methods", () => {
        describe(".loginWithCredentials", () => {
            it("should login correctly", async () => {
                await APIClient.loginWithCredentials(INSTALLATION, USERNAME, PASSWORD);
            });
        });
    });

    describe("instance methods", () => {
        let api;
        beforeEach(async () => {
            api = await localAPIClient();
        });

        describe("#sendFrame", () => {
            it("should not send frame on disconnect", async () => {
                api.socket.close();
                
                try {
                    await api.sendFrame("test-frame", {});
                } catch(err) {
                    assert.equal("Socket is not connected to the server. Please reconnect.", err.message);
                }
            });
        });
    });
});