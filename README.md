# `tw-chat`
## CLI
#### Installation
Run:

```sh
npm install -f @teamwork/chat-almighty
```

#### Manual install
Clone the repository and `npm install`:

    $ git clone https://github.com/adriancooney/chat-api-client.git
    $ cd chat-api-client/
    $ npm install

Next, build the CLI and then `npm link`:

    $ npm run build
    $ npm link

#### Development
Clone the repository and `npm install`:

    $ git clone https://github.com/adriancooney/chat-api-client.git
    $ cd chat-api-client/
    $ npm install

Next, install `babel-cli` globally and then link the `tw-chat` binary into a folder in your `$PATH`:

    $ npm install -g babel-cli
    $ ln -s ./bin/tw-chat /usr/local/bin/tw-chat

*Warning: this version is much slower than the release or manual install. It's due to compiling the code on the fly (twice, because of the sub-commands).*

## API
#### Authentication
To get started with talking to chat, we need to authenticate. We start from one of the various methods:

* `fromKey(<installation>, <key>)` - Login with your API key.
* `fromAuth(<installation>, <auth token>)` - Login with an existing auth token (`tw-auth` cookie).
* `fromCredentials(<installation>, <username>, <password>)` - Login with a username and password. I recommend using an environment variable for the password instead of hardcoding it: `fromCredentials(<installation>, <username>, process.env.TW_PASS)`

These functions all return a promise that resolves to a new `TeamworkChat` instance when the authentication flow is complete. The authentication flow consists of logging into Launchpad, opening a Websocket to Teamwork Chat and then completing Teamwork Chat's authentication flow so it's a little slow. Once the promise resolves, you are now connected to TeamworkChat.

```js
TeamworkChat.fromKey("digitalcrew.teamwork.com", "my4pik3y").then(chat => {
    return chat.getPersonByHandle("adrianc");
}).then(adrian => {
    return adrian.sendMessage("Morning.");
});
```

For more documentation on how to use the `TeamworkChat` instance and the other models it returns, jump into the source code comments.

* `TeamworkChat` - [src/TeamworkChat.js](src/TeamworkChat.js)
* `Room` - [src/Room.js](src/Room.js)
* `Person` - [src/Person.js](src/Person.js)
* `Message` - [src/Message.js](src/Message.js)