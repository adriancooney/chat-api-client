import winston from "winston";
import TeamworkChat from "./TeamworkChatTransport";

// Add Chat as a Winston Transport for some pretty slick logging
const chat = winston.add(TeamworkChat, { 
    room: 3033,
    installation: "http://1486461376533.teamwork.com",
    auth: "j8bFk1PZGjyZQeQhlvhvzqJVg9iCkz-120606"
});

winston.log("info", "Hello");

setTimeout(() => {
    // Don't forget to close the connection to Teamwork Chat
    winston.remove(winston.transports.TeamworkChat);
}, 3000);