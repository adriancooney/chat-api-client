# `tw-chat`
## CLI
### Installation

#### Release
`npm install -f @teamwork/chat-almighty`

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