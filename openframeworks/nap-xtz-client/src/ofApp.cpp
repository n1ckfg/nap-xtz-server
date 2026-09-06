#include "ofApp.h"

#include "Pinopticon.hpp"
#include "Pinopticon_Http.hpp"

//using namespace cv;
//using namespace ofxCv;
using namespace Pinopticon;

//--------------------------------------------------------------
void ofApp::setup() {
    ofSetWindowTitle("PiNaplpsPlayer");
    ofSetFrameRate(60);
    //ofSetVerticalSync(true);
    //ofEnableAntiAliasing();
    //ofEnableAlphaBlending(); // Alpha disabled for performance
    ofBackground(0);
    ofHideCursor();

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
}

//--------------------------------------------------------------
void ofApp::loadNap(const std::string & filePath) {
    // 1. decode the file
    //naplps.setVerbose(true); // uncomment to log every command and point
    if (!naplps.load(filePath)) return;

    // 2. hand the decoded commands to the renderer
    startDrawing();
}

//--------------------------------------------------------------
// The same thing for a drawing that arrived over the network: the bytes are
// already in hand, so they go straight to the decoder without touching a file.
void ofApp::showNap(const std::string & napRaw, const std::string & label) {
    naplps.decode(napRaw);

    if (!naplps.isLoaded()) {
        ofLogWarning("PiNaplpsPlayer") << "nothing to draw in " << label;
        return;
    }

    // decode() doesn't set a file name, and the old one would be a lie.
    naplps.fileName = label;

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
	drawSize = 720; //MIN(ofGetWidth(), ofGetHeight());
	drawOffset = glm::vec2(0, 540 - 720); //glm::vec2((ofGetWidth() - drawSize) / 2.0f, (ofGetHeight() - drawSize) / 2.0f);
    bFboDirty = true;
}

//--------------------------------------------------------------
void ofApp::update() {
    // Collect whatever the websocket thread left for us. Only the newest
    // drawing is kept: a player shows one at a time, so an older frame that
    // arrived in the same window has already been superseded.
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

    telidon.update();

    if (showInfo) {
        static std::string lastState = "";
        std::string currentState = ofToString(connections) + "_" + ofToString(received) + "_" + (telidon.isFinished() ? "1" : "0") + "_" + napSource + "_" + naplps.fileName + "_" + ofToString(progressiveDraw) + "_" + ofToString(labelPoints);
        if (currentState != lastState) {
            updateInfoText();
            lastState = currentState;
        }
    }
}

//--------------------------------------------------------------
void ofApp::draw() {
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
        ofLogWarning("PiNaplpsPlayer") << "frame wasn't valid JSON";
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
    ofLogNotice("PiNaplpsPlayer") << "websocket opened: " << evt.connection().clientAddress().toString();
}

//--------------------------------------------------------------
void ofApp::onWebSocketCloseEvent(ofxHTTP::WebSocketCloseEventArgs & evt) {
    if (connections > 0) connections--;
    ofLogNotice("PiNaplpsPlayer") << "websocket closed: " << evt.connection().clientAddress().toString();
}

//--------------------------------------------------------------
void ofApp::onWebSocketFrameReceivedEvent(ofxHTTP::WebSocketFrameEventArgs & evt) {
    const NapFrame frame = parseNapFrame(evt.frame().toString());
    if (frame.nap.empty()) return;

    ofLogNotice("PiNaplpsPlayer") << "received " << frame.nap.size() << " bytes of NAPLPS"
                                  << (frame.source.empty() ? "" : " from " + frame.source);

    // Hand it to update(); this is a server thread, not the GL thread.
    std::lock_guard<std::mutex> lock(incomingMutex);
    incoming = frame;
    hasIncoming = true;
    received++;
}

//--------------------------------------------------------------
void ofApp::onWebSocketFrameSentEvent(ofxHTTP::WebSocketFrameEventArgs & evt) {
    // nothing to do -- the player only listens
}

//--------------------------------------------------------------
void ofApp::onWebSocketErrorEvent(ofxHTTP::WebSocketErrorEventArgs & evt) {
    ofLogWarning("PiNaplpsPlayer") << "websocket error: " << evt.connection().clientAddress().toString();
}

//--------------------------------------------------------------
void ofApp::keyPressed(int key) {
    switch (key) {
        case ' ':
            telidon.reset();
            bFboDirty = true;
            break;
        case OF_KEY_RIGHT:
        case OF_KEY_DOWN:
            sampleIndex = (sampleIndex + 1) % (int)samples.size();
            loadNap(samples[sampleIndex]);
            napSource = "file";
            break;
        case OF_KEY_LEFT:
        case OF_KEY_UP:
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
        case 'f':
            ofToggleFullscreen();
            break;
        default:
            break;
    }
}

//--------------------------------------------------------------
void ofApp::windowResized(int w, int h) {
    updateLayout();
    telidon.setSize(drawSize, drawSize);
}

//--------------------------------------------------------------
void ofApp::dragEvent(ofDragInfo dragInfo) {
    if (dragInfo.files.size() < 1) return;

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
    infoText += "ws://" + hostName + ":" + ofToString(WS_PORT) + "\n";
    infoText += ofToString(connections) + " connected, " + ofToString(received) + " received\n";
    infoText += "\n";
    infoText += "arrows: next/prev file\n";
    infoText += "space:  redraw\n";
    infoText += "p:      progressive draw " + std::string(progressiveDraw ? "on" : "off") + "\n";
    infoText += "l:      label points " + std::string(labelPoints ? "on" : "off") + "\n";
    infoText += "i:      hide this\n";
    infoText += "(or drop a .nap file on the window)";
}
