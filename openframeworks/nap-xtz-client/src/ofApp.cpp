#include "ofApp.h"

#include "Pinopticon.hpp"
#include "Pinopticon_Http.hpp"

using namespace Pinopticon;

//--------------------------------------------------------------
void ofApp::setup() {
    ofSetWindowTitle("nap-xtz-client");
    ofSetFrameRate(60);
    ofBackground(0);

    // the other sample files in bin/data, cycled through with the arrow keys
    samples.push_back("shark.nap");
    samples.push_back("santa.nap");
    samples.push_back("beer.nap");
    samples.push_back("haunt.nap");
    samples.push_back("wast.nap");
    samples.push_back("email2.nap");
    sampleIndex = 0;

    progressiveDraw = true;
    labelPoints = false;
    showInfo = false;
    bFboDirty = true;

    slideshowActive = false;
    slideshowInterval = 10.0f;
    lastSlideTime = 0.0f;
    sendSlideshowToRpi = false;

    updateLayout();
    loadNap(samples[sampleIndex]);
    napSource = "file";

    // The websocket server starts listening the moment it's set up, so
    // everything a frame touches has to be ready first.
    hasIncoming = false;
    received = 0;
    connections = 0;
    hostName = Pinopticon::getHostName();

    Pinopticon::setupWsServer(this, wsServer, WS_PORT, MAX_NAP_BYTES);

    fbo.allocate(720, 540, GL_RGB);

    // ~ ~ ~ outbound link to nap-xtz-server ~ ~ ~
    // Overridable from bin/data/settings.json, so a Pi in an installation can
    // point at the server without a rebuild.
    NapClient::Settings clientSettings;

    ofxJSONElement settingsJson;
    if (settingsJson.open(ofToDataPath("settings.json"))) {
        if (settingsJson.isMember("server_host")) {
            clientSettings.host = settingsJson["server_host"].asString();
        }
        if (settingsJson.isMember("server_ws_port")) {
            clientSettings.wsPort = settingsJson["server_ws_port"].asInt();
        }
        if (settingsJson.isMember("server_http_port")) {
            clientSettings.httpPort = settingsJson["server_http_port"].asInt();
        }
        if (settingsJson.isMember("slideshow_interval")) {
            slideshowInterval = settingsJson["slideshow_interval"].asFloat();
        }
        if (settingsJson.isMember("slideshow_to_rpi")) {
            sendSlideshowToRpi = settingsJson["slideshow_to_rpi"].asBool();
        }
    } else {
        ofLogNotice("nap-xtz-client") << "no settings.json, using defaults";
    }

    client.setup(clientSettings);
    client.start();

    // The camera and the gesture model both take seconds to come up, so live
    // drawing is prepared now rather than when the user asks for it.
    drawingMode.setup();
}

//--------------------------------------------------------------
void ofApp::exit() {
    drawingMode.exit();
    client.stop();
}

//--------------------------------------------------------------
void ofApp::loadNap(const std::string & filePath) {
    // 1. decode the file
    if (!naplps.load(filePath)) return;

    // Keep the raw bytes: publishing or minting what's on screen needs them.
    pendingNapRaw = naplps.napRaw;

    // 2. hand the decoded commands to the renderer
    startDrawing();
}

//--------------------------------------------------------------
// The same thing for a drawing that arrived over the network: the bytes are
// already in hand, so they go straight to the decoder without touching a file.
void ofApp::showNap(const std::string & napRaw, const std::string & label) {
    naplps.decode(napRaw);

    if (!naplps.isLoaded()) {
        ofLogWarning("nap-xtz-client") << "nothing to draw in " << label;
        return;
    }

    // decode() doesn't set a file name, and the old one would be a lie.
    naplps.fileName = label;
    pendingNapRaw = napRaw;

    startDrawing();
}

//--------------------------------------------------------------
void ofApp::startDrawing() {
    telidon.setup(naplps, drawSize, drawSize);
    telidon.setProgressiveDraw(progressiveDraw);
    telidon.setLabelPoints(labelPoints);
    bFboDirty = true;
}

//--------------------------------------------------------------
void ofApp::updateLayout() {
    drawSize = 720;
    drawOffset = glm::vec2(0, 540 - 720);
    bFboDirty = true;
}

//--------------------------------------------------------------
void ofApp::update() {
    // Live drawing takes the whole window; the NAPLPS canvas idles behind it.
    if (drawingMode.isActive()) {
        drawingMode.update();

        // A two-handed Thumb_Up asks to leave. The mode doesn't know what
        // happens to the drawing afterwards, so it only raises the flag.
        if (drawingMode.isExitRequested()) {
            drawingMode.clearExitRequested();
            leaveDrawingMode();
        }
        return;
    }

    // ~ ~ ~ drawings pushed to us by nap-xtz-server (inbound server) ~ ~ ~
    NapFrame frame;
    bool gotOne = false;
    {
        std::lock_guard<std::mutex> lock(incomingMutex);
        if (hasIncoming) {
            frame = incoming;
            hasIncoming = false;
            gotOne = true;
        }
    }

    if (gotOne) {
        napSource = frame.source.empty() ? "network" : frame.source;
        showNap(frame.nap, "(" + napSource + ")");
    }

    // ~ ~ ~ drawings broadcast to us as a client (outbound link) ~ ~ ~
    // Only the newest is kept: a player shows one at a time, so anything older
    // that arrived in the same window has already been superseded.
    NapClient::Message message;
    bool gotMessage = false;
    while (client.getNextMessage(message)) gotMessage = true;

    if (gotMessage) {
        stopSlideshow(); // live content takes over
        napSource = message.source.empty() ? "server" : message.source;
        showNap(message.naplps, "(" + napSource + ")");
    }

    // ~ ~ ~ slideshow ~ ~ ~
    if (slideshowActive && ofGetElapsedTimef() - lastSlideTime >= slideshowInterval) {
        loadRandomNap();
    }

    telidon.update();

    if (showInfo) {
        static std::string lastState = "";
        std::string currentState = ofToString(connections) + "_" + ofToString(received) + "_"
            + (telidon.isFinished() ? "1" : "0") + "_" + napSource + "_" + naplps.fileName + "_"
            + ofToString(progressiveDraw) + "_" + ofToString(labelPoints) + "_"
            + client.getStatusText() + "_" + client.getMintStatus() + "_"
            + ofToString(slideshowActive);
        if (currentState != lastState) {
            updateInfoText();
            lastState = currentState;
        }
    }
}

//--------------------------------------------------------------
void ofApp::draw() {
    if (drawingMode.isActive()) {
        drawingMode.draw();
        return;
    }

    if (!telidon.isFinished() || bFboDirty) {
        fbo.begin();
        ofBackground(0);

        ofPushMatrix();
        ofTranslate(drawOffset.x, drawOffset.y);
        telidon.draw();
        ofPopMatrix();
        fbo.end();

        if (telidon.isFinished()) {
            bFboDirty = false;
        }
    }

    fbo.draw(0, 0, 720, 480);

    if (showInfo) {
        ofDrawBitmapStringHighlight(infoText, 10, 20);
    }
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// LIVE DRAWING
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

//--------------------------------------------------------------
void ofApp::enterDrawingMode() {
    stopSlideshow(); // as in the browser: drawing blocks the slideshow
    ofShowCursor();
    drawingMode.start();
}

//--------------------------------------------------------------
void ofApp::leaveDrawingMode() {
    drawingMode.stop(); // encodes whatever was drawn

    const std::string encoded = drawingMode.getEncodedNaplps();
    if (encoded.empty()) {
        ofLogNotice("nap-xtz-client") << "left drawing mode with nothing drawn";
        bFboDirty = true;
        return;
    }

    // Show it on the NAPLPS canvas, then share it. This is the round trip the
    // whole app exists for: hands to vectors to every other client.
    showNap(encoded, "(live drawing)");
    napSource = "drawing";

    client.publish(encoded, "drawing");
    drawingMode.clearEncodedNaplps();
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// SLIDESHOW
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

//--------------------------------------------------------------
void ofApp::startSlideshow() {
    if (drawingMode.isActive() || slideshowActive) return;
    slideshowActive = true;
    loadRandomNap();
}

//--------------------------------------------------------------
void ofApp::stopSlideshow() {
    slideshowActive = false;
}

//--------------------------------------------------------------
void ofApp::loadRandomNap() {
    if (samples.empty()) return;

    // Picked at random rather than in order, matching the browser. Repeats are
    // possible and that's fine for an ambient display.
    const int index = (int)ofRandom(0, samples.size());
    sampleIndex = std::min(index, (int)samples.size() - 1);

    if (!naplps.load(samples[sampleIndex])) return;
    pendingNapRaw = naplps.napRaw;
    startDrawing();

    napSource = "slideshow";
    lastSlideTime = ofGetElapsedTimef();

    // The browser's slideshow mirrors every frame to the Pi. Off by default
    // here, because this app may be that Pi -- see the header.
    if (sendSlideshowToRpi) client.sendToRpi(pendingNapRaw, "slideshow");
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// NETWORK (OUTBOUND)
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

//--------------------------------------------------------------
void ofApp::publishCurrent() {
    if (pendingNapRaw.empty()) {
        ofLogNotice("nap-xtz-client") << "nothing on screen to publish";
        return;
    }
    client.publish(pendingNapRaw, "client");
    ofLogNotice("nap-xtz-client") << "published " << pendingNapRaw.size() << " bytes";
}

//--------------------------------------------------------------
void ofApp::mintCurrent() {
    if (pendingNapRaw.empty()) {
        ofLogNotice("nap-xtz-client") << "nothing on screen to mint";
        return;
    }

    // The browser signs with a Beacon wallet. There is no Beacon for C++, so
    // this asks the server to sign with its own key; it answers with a clear
    // error when TEZOS_SECRET_KEY isn't configured there.
    client.mintAsync(pendingNapRaw);
    showInfo = true; // so the result is visible when it lands
    updateInfoText();
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// NETWORK (INBOUND)
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

//--------------------------------------------------------------
// Frames from nap-xtz-server arrive in one of three shapes, set by
// RPI_NAPLPS_FORMAT on that side:
//
//   json    {"type":"naplps","source":"slideshow","encoding":"text","naplps":"..."}
//   base64  the same envelope, with the stream base64'd
//   raw     the NAPLPS stream on its own, no envelope
//
// Anything else on this port -- a camera command meant for one of the other
// Pinopticon apps, a keepalive -- is not a drawing and is left alone.
ofApp::NapFrame ofApp::parseNapFrame(const std::string & text) const {
    NapFrame frame;

    if (text.empty()) return frame;

    // A .nap stream opens with a control byte, never with '{'.
    if (text[0] != '{') {
        if (text == "take_photo" || text == "stream_photo" || text == "keepalive") return frame;
        frame.nap = text;
        frame.source = "raw";
        return frame;
    }

    ofxJSONElement json;
    if (!json.parse(text)) {
        ofLogWarning("nap-xtz-client") << "frame wasn't valid JSON";
        return frame;
    }

    if (json["type"].asString() != "naplps") return frame;

    frame.source = json["source"].asString();

    // NAPLPS is a 7-bit-safe format, so "text" carries the stream through JSON
    // intact -- the control bytes travel as \u00xx escapes and come back whole.
    // "base64" is there for a payload that uses the high half anyway.
    const std::string payload = json["naplps"].asString();
    frame.nap = (json["encoding"].asString() == "base64")
        ? ofxCrypto::base64_decode(payload)
        : payload;

    return frame;
}

//--------------------------------------------------------------
void ofApp::onWebSocketOpenEvent(ofxHTTP::WebSocketEventArgs & evt) {
    connections++;
    ofLogNotice("nap-xtz-client") << "websocket opened: " << evt.connection().clientAddress().toString();
}

//--------------------------------------------------------------
void ofApp::onWebSocketCloseEvent(ofxHTTP::WebSocketCloseEventArgs & evt) {
    if (connections > 0) connections--;
    ofLogNotice("nap-xtz-client") << "websocket closed: " << evt.connection().clientAddress().toString();
}

//--------------------------------------------------------------
void ofApp::onWebSocketFrameReceivedEvent(ofxHTTP::WebSocketFrameEventArgs & evt) {
    const NapFrame frame = parseNapFrame(evt.frame().toString());
    if (frame.nap.empty()) return;

    ofLogNotice("nap-xtz-client") << "received " << frame.nap.size() << " bytes of NAPLPS"
                                  << (frame.source.empty() ? "" : " from " + frame.source);

    // Hand it to update(); this is a server thread, not the GL thread.
    std::lock_guard<std::mutex> lock(incomingMutex);
    incoming = frame;
    hasIncoming = true;
    received++;
}

//--------------------------------------------------------------
void ofApp::onWebSocketFrameSentEvent(ofxHTTP::WebSocketFrameEventArgs & evt) {
    // nothing to do -- this side only listens
}

//--------------------------------------------------------------
void ofApp::onWebSocketErrorEvent(ofxHTTP::WebSocketErrorEventArgs & evt) {
    ofLogWarning("nap-xtz-client") << "websocket error: " << evt.connection().clientAddress().toString();
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// INPUT
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

//--------------------------------------------------------------
void ofApp::keyPressed(int key) {
    // 'd' and fullscreen work in both modes; everything else belongs to one.
    if (key == 'd') {
        if (drawingMode.isActive()) {
            leaveDrawingMode();
        } else {
            enterDrawingMode();
        }
        return;
    }

    if (key == 'f') {
        ofToggleFullscreen();
        return;
    }

    if (drawingMode.isActive()) {
        drawingMode.keyPressed(key);
        return;
    }

    switch (key) {
        case ' ':
            telidon.reset();
            bFboDirty = true;
            break;
        case OF_KEY_RIGHT:
        case OF_KEY_DOWN:
            stopSlideshow();
            sampleIndex = (sampleIndex + 1) % (int)samples.size();
            loadNap(samples[sampleIndex]);
            napSource = "file";
            break;
        case OF_KEY_LEFT:
        case OF_KEY_UP:
            stopSlideshow();
            sampleIndex = (sampleIndex + (int)samples.size() - 1) % (int)samples.size();
            loadNap(samples[sampleIndex]);
            napSource = "file";
            break;
        case 'p':
            progressiveDraw = !progressiveDraw;
            telidon.setProgressiveDraw(progressiveDraw);
            bFboDirty = true;
            break;
        case 'l':
            labelPoints = !labelPoints;
            telidon.setLabelPoints(labelPoints);
            bFboDirty = true;
            break;
        case 'i':
            showInfo = !showInfo;
            if (showInfo) updateInfoText();
            break;
        case 's':
            if (slideshowActive) {
                stopSlideshow();
            } else {
                startSlideshow();
            }
            break;
        case 'n':
            publishCurrent();
            break;
        case 'm':
            mintCurrent();
            break;
        case 'c': {
            // Pull the newest drawing on chain, the browser's "latest" link.
            NapClient::Message latest;
            std::string error;
            if (client.fetchLatest(latest, error)) {
                stopSlideshow();
                showNap(latest.naplps, "(token " + ofToString(latest.tokenId) + ")");
                napSource = "chain";
            } else {
                ofLogWarning("nap-xtz-client") << "latest: " << error;
            }
            break;
        }
        default:
            break;
    }
}

//--------------------------------------------------------------
void ofApp::keyReleased(int key) {
    if (drawingMode.isActive()) drawingMode.keyReleased(key);
}

//--------------------------------------------------------------
void ofApp::mouseMoved(int x, int y) {
    if (drawingMode.isActive()) drawingMode.mouseMoved(x, y);
}

//--------------------------------------------------------------
void ofApp::mouseDragged(int x, int y, int button) {
    if (drawingMode.isActive()) drawingMode.mouseDragged(x, y, button);
}

//--------------------------------------------------------------
void ofApp::mousePressed(int x, int y, int button) {
    if (drawingMode.isActive()) drawingMode.mousePressed(x, y, button);
}

//--------------------------------------------------------------
void ofApp::mouseReleased(int x, int y, int button) {
    if (drawingMode.isActive()) drawingMode.mouseReleased(x, y, button);
}

//--------------------------------------------------------------
void ofApp::mouseScrolled(int x, int y, float scrollX, float scrollY) {
    if (drawingMode.isActive()) drawingMode.mouseScrolled(scrollY);
}

//--------------------------------------------------------------
void ofApp::windowResized(int w, int h) {
    updateLayout();
    telidon.setSize(drawSize, drawSize);
}

//--------------------------------------------------------------
void ofApp::dragEvent(ofDragInfo dragInfo) {
    if (dragInfo.files.size() < 1) return;
    if (drawingMode.isActive()) return;

    stopSlideshow(); // a deliberate load takes over from the slideshow
    loadNap(dragInfo.files[0]);
    napSource = "file";
}

//--------------------------------------------------------------
void ofApp::updateInfoText() {
    infoText = naplps.fileName + "\n";
    infoText += "Telidon " + ofToString(naplps.version) + ", " + ofToString(naplps.cmds.size()) + " commands\n";
    infoText += telidon.isFinished() ? "finished\n" : "drawing...\n";
    infoText += "source: " + napSource + "\n";
    infoText += "\n";
    infoText += "server: " + client.getStatusText() + "\n";
    if (!client.getMintStatus().empty()) {
        infoText += "mint:   " + client.getMintStatus() + "\n";
    }
    infoText += "listening on ws://" + hostName + ":" + ofToString(WS_PORT) + "\n";
    infoText += ofToString(connections) + " connected, " + ofToString(received) + " received\n";
    infoText += "\n";
    infoText += "d:      live drawing\n";
    infoText += "s:      slideshow " + std::string(slideshowActive ? "on" : "off") + "\n";
    infoText += "n:      publish this drawing\n";
    infoText += "m:      mint this drawing\n";
    infoText += "c:      load latest from chain\n";
    infoText += "arrows: next/prev file\n";
    infoText += "space:  redraw\n";
    infoText += "p:      progressive draw " + std::string(progressiveDraw ? "on" : "off") + "\n";
    infoText += "l:      label points " + std::string(labelPoints ? "on" : "off") + "\n";
    infoText += "i:      hide this\n";
    infoText += "(or drop a .nap file on the window)";
}
