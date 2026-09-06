#pragma once

#include <mutex>

#include "ofMain.h"

#include "ofxNaplps.h"

#include "ofxHTTP.h"
#include "ofxJSONElement.h"
#include "ofxCrypto.h"



// The largest drawing the player will accept over a websocket, matching
// RPI_MAX_BYTES on the server. ofxHTTP defaults its websocket buffer to 8 KB,
// which is smaller than every .nap file in bin/data -- and Poco drops a frame
// that won't fit the buffer, so at the default the player would simply never
// see a drawing arrive.
#define MAX_NAP_BYTES (1024 * 1024)

// The port nap-xtz-server connects to (its RPI_PORT), and the one the
// Pinopticon apps use for websockets.
#define WS_PORT 7112

class ofApp : public ofBaseApp {

    public:

        void setup();
        void update();
        void draw();

        void keyPressed(int key);
        void windowResized(int w, int h);
        void dragEvent(ofDragInfo dragInfo);

        void loadNap(const std::string & filePath);
        void showNap(const std::string & napRaw, const std::string & label);
        void startDrawing();
        void updateLayout();

        Naplps naplps;   // the decoder,  ported from naplps.js
        Telidon telidon; // the renderer, ported from TelidonP5.js
	
		ofFbo fbo;
	
        std::vector<std::string> samples;
        int sampleIndex;

        // The NAPLPS unit screen runs from (0,0) to (1,1), so it gets a square
        // of the window, centered.
        float drawSize;
        glm::vec2 drawOffset;

        bool progressiveDraw;
        bool labelPoints;
        bool showInfo;

        bool bFboDirty;
        std::string infoText;
        void updateInfoText();

        // ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
        // NETWORK
        //
        // nap-xtz-server opens a websocket to this app and pushes drawings as
        // its own canvas draws them -- slideshow mode sends every frame it
        // plays. See that project's OTHER SERVERS section in app.js.
        // ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

        // One drawing lifted out of a websocket frame. nap is empty when the
        // frame wasn't a drawing at all.
        struct NapFrame {
            std::string nap;
            std::string source; // "slideshow", "chain", ... when the sender says
        };

        NapFrame parseNapFrame(const std::string & text) const;

        ofxHTTP::SimpleWebSocketServer wsServer;

        void onWebSocketOpenEvent(ofxHTTP::WebSocketEventArgs & evt);
        void onWebSocketCloseEvent(ofxHTTP::WebSocketCloseEventArgs & evt);
        void onWebSocketFrameReceivedEvent(ofxHTTP::WebSocketFrameEventArgs & evt);
        void onWebSocketFrameSentEvent(ofxHTTP::WebSocketFrameEventArgs & evt);
        void onWebSocketErrorEvent(ofxHTTP::WebSocketErrorEventArgs & evt);

        // Frames arrive on one of the server's own threads, so a drawing waits
        // here until update() collects it: decoding and rendering both belong
        // to the GL thread.
        std::mutex incomingMutex;
        NapFrame incoming;
        bool hasIncoming;

        std::string hostName;   // read once; it shells out to `hostname`
        std::string napSource;  // where the drawing on screen came from
        int received;
        int connections;

};
