# PiNaplpsPlayer Architecture

PiNaplpsPlayer is an openFrameworks application designed to receive and render NAPLPS (North American Presentation Level Protocol Syntax) graphics. It operates both as a standalone file viewer and as a WebSocket server that can receive live streams of NAPLPS drawings over the network.

## Core Components

### Application Lifecycle (`ofApp`)
- **`setup()`**: Initializes window settings, loads local `.nap` sample files, sets up an `ofFbo` for rendering, and starts the WebSocket server listening on port 7112.
- **`update()`**: Safely pulls any new drawing frames off the incoming network queue (protected by a mutex) and pushes them to the decoder. Updates the `Telidon` renderer state.
- **`draw()`**: Renders the current state of the drawing via the `Telidon` object to an `ofFbo`, which is then scaled and drawn to the screen. Also displays an overlay with current status, connection count, and hotkey information.

### NAPLPS Processing
The core graphics processing is handled by the `ofxNaplps` openFrameworks addon:
- **`Naplps` (Decoder)**: Parses raw NAPLPS byte streams or `.nap` files into an internal representation of drawing commands.
- **`Telidon` (Renderer)**: Takes the parsed commands from the decoder and performs the actual OpenGL drawing commands to render the graphics to the screen. It supports progressive drawing (animating the drawing process over time) and point labeling.

### Network Layer
- **WebSocket Server**: Uses `ofxHTTP` (via the `Pinopticon_Http.hpp` wrapper) to run a WebSocket server on a dedicated thread. 
- **Message Parsing**: Frames can arrive in JSON format (with either raw text or base64 encoded payloads) or as raw NAPLPS streams. The application parses the incoming frames, extracts the NAPLPS data, and places it into a thread-safe incoming queue (`incomingMutex`).
- **External Integration**: Designed to receive streams pushed by an external server (e.g., `nap-xtz-server`).

### Pinopticon Utilities
The `src/` directory includes several utility headers under the `Pinopticon` namespace, providing reusable network and utility wrappers:
- **`Pinopticon.hpp`**: General utilities (hostname resolution, timestamps, image/FBO to buffer conversion).
- **`Pinopticon_Http.hpp`**: Wrappers for setting up `ofxHTTP` MJPEG streams, POST servers, and WebSocket servers, as well as functions to broadcast data.
- **`Pinopticon_Osc.hpp`**: Wrappers for setting up and sending messages via `ofxOsc`.

## Data Flow
1. **Input**:
   - **Local File**: User drags and drops a `.nap` file or uses arrow keys to cycle through samples.
   - **Network**: WebSocket server receives a frame containing NAPLPS data.
2. **Decoding**: `naplps.decode()` or `naplps.load()` processes the byte stream into drawing commands.
3. **Rendering Prep**: `telidon.setup()` is initialized with the decoded commands.
4. **Drawing**: During `ofApp::draw()`, `telidon.draw()` executes the OpenGL commands onto an `ofFbo`, which is presented to the window.

## Addons
The project relies on the following openFrameworks addons (as listed in `addons.make`):
- `ofxNaplps`
- `ofxHTTP`
- `ofxIO`
- `ofxMediaType`
- `ofxNetworkUtils`
- `ofxPoco`
- `ofxSSLManager`
- `ofxJSON`
- `ofxCrypto`
