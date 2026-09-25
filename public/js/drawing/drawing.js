import * as THREE from 'three';
import { Controller } from './controller.js';
import { HandTracker, HandInput } from './hands.js';
import { MouseController } from './mouse.js';
import { OpenXR_WorldScale } from './worldscale.js';
import { Frame, BRUSH_SIMPLIFY, MIN_STEP } from './tools.js';
import { Palette } from './palette.js';
import { createVHSCPass } from '../shaders/vhsc-three.js';
import { AttractMode } from './attract.js';

let video;

// The recognizer runs in a worker (see hands.js) and its results are taken a
// frame at a time; HandInput keeps each hand on its own controller.
let handTracker = null;
let handInput = null;

// How far a fingertip's depth moves its point toward or away from the camera,
// per unit of the recognizer's z (which is relative to the wrist, and noisy).
const HAND_DEPTH_SCALE = 5;

// Three.js variables
let scene, camera, renderer;
let pointerMeshes = [];
let controllers = [];
let labels = [];
let labelsContainer;

let worldNode;
let worldScale;
let frame;
let vhscPass = null;
let _armDelete = false;
let attractMode = null;

const MAX_HANDS = 2;

// Reused scratch vector for per-frame draw-position reads (Frame clones the
// position before storing it, so a single shared instance is safe).
const _drawPos = new THREE.Vector3();

// The drawing view renders at 4:3 to match the main p5 canvas (640x480),
// centered and letterboxed within the fullscreen container.
const DRAW_ASPECT = 640 / 480;

// A minted drawing has to fit the chain: app.js refuses one over its
// TEZOS_MAX_BYTES (set in .env), which GET /api/config reports. There is no
// figure of our own -- until the config has come this is null, and a drawing
// encoded meanwhile isn't fitted to anything. mintDrawing() waits for it.
let maxNaplpsBytes = null;

// Fetches the limit if it hasn't come yet. Resolves to it, or to null when the
// backend can't be reached -- in which case it can't mint either.
function loadSizeLimit() {
    if (!window.NapClient || typeof window.NapClient.getConfig !== 'function') {
        return Promise.resolve(maxNaplpsBytes);
    }
    return window.NapClient.getConfig()
        .then(config => {
            if (config && config.maxNaplpsBytes > 0) maxNaplpsBytes = config.maxNaplpsBytes;
            return maxNaplpsBytes;
        })
        .catch(err => {
            console.warn('[nap-xtz] no size limit from the backend:', err.message);
            return maxNaplpsBytes;
        });
}

// How many times convertToNAPLPS() may coarsen the brush to get under it.
// The ladder now starts at the encoder's own quantum rather than four times it,
// so it needs three more rungs to reach the same place: eight doublings take the
// tolerance from a third of a pixel to about forty, which covers the busiest
// drawing the corpus has (a hundred strokes needed six of them).
const MAX_SIMPLIFY_PASSES = 8;

// Largest 4:3 box that fits the window ("contain"), plus its centering offset.
function getDrawSize() {
    const w = Math.min(window.innerWidth, window.innerHeight * DRAW_ASPECT);
    const h = w / DRAW_ASPECT;
    return {
        w: w,
        h: h,
        offsetX: (window.innerWidth - w) / 2,
        offsetY: (window.innerHeight - h) / 2
    };
}

// Palette state per controller
const paletteRadius = 1.2; //0.5;
const paletteSwatchSize = 0.2; //0.1;
const PALETTE_HOLD_DURATION = 1600; // 1.6 seconds to reveal palette
const PALETTE_FLICKER_DURATION = 300; // 0.3 seconds
let palettes = [];
let paletteGripStartTime = []; // When grip started for each controller
let paletteVisible = []; // Whether palette is visible for each controller
let paletteSpawned = []; // Whether palette position has been set during flicker preview
let paletteSpawnPos = []; // Where palette spawned
let paletteLines = []; // Line from palette center to controller
let paletteFlickerStart = []; // When color selection flicker started
let paletteFlickerIndex = []; // Which color index is flickering
let controllerDrawColor = []; // Drawing color per controller (hex)
let controllerColorRims = []; // Rim meshes showing selected color

// Mouse controller state
let mouseController = null;
let mousePalette = null;
let mousePaletteVisible = false;
let mouseDrawColor = 0xffffff;
const MOUSE_CONTROLLER_ID = 'mouse';

// Keyboard/Mouse navigation state
const keysPressed = {};
const mouseSensitivity = 0.003;
const panSensitivity = 0.01;
const zoomSensitivity = 0.001;
const moveSpeed = 0.1;
let lastMouseX = 0;
let lastMouseY = 0;
let isMouseActive = false;

// Camera spherical coordinates for orbit
let cameraRadius = 5;
let cameraTheta = Math.PI / 2; // horizontal angle (start at z-axis)
let cameraPhi = Math.PI / 2; // vertical angle (horizontal plane)
let cameraTarget = new THREE.Vector3(0, 0, 0);

// Undo/Reset timer state
let undoHoldStart = null;
const UNDO_HOLD_DURATION = 2000; // 2 seconds
const UNDO_FLICKER_DURATION = 300; // 0.3 seconds
let undoFlickerStart = null;
let undoRearmAt = -Infinity; // a hold can't start before the last one's flicker ended
let undoDoneAt = null;       // when a one-handed hold filled, if it is waiting for a second hand
let undoOverlay = null;
let undoCircleLeft = null;
let undoCircleRight = null;
const UNDO_CIRCLE_MAX_SIZE = 400; // pixels
const UNDO_CIRCLE_MIN_SCALE = 0.1; // 10%
const UNDO_CIRCLE_SPACING = 0.5; // 50% of circle width apart
let pendingAction = null; // 'undo' or 'reset'

// Kiosk-visible status line (mint feedback)
let drawingStatusEl = null;
let drawingStatusTimer = null;
const DRAWING_STATUS_HOLD = 6000; // ms a finished message stays up

// Gesture guide card (the hand-sign chart), shown on entering drawing mode and
// on the thumbs-up camera reset
let gestureCardEl = null;
let gestureCardFadeTimer = null;
let gestureCardHideTimer = null;
const GESTURE_CARD_HOLD = 5000; // ms the card stays up before it starts fading
const GESTURE_CARD_FADE = 1000; // must match the transition in main.css

// Confirm (green expanding) circle state
let confirmOverlay = null;
let confirmCircleLeft = null;
let confirmCircleRight = null;
let confirmHoldStart = null;
let confirmFlickerStart = null;
let confirmRearmAt = -Infinity;
let confirmDoneAt = null;
let confirmIsDouble = false; // single or double circle
let pendingConfirmAction = null; // 'single' or 'double'

// Orientation objects fade state
let orientationObjects = []; // Array of {mesh, material}
let orientationFadeStart = null;
const ORIENTATION_FADE_DURATION = 5000; // 5 seconds

async function setupMediaPipe() {
    const container = window._drawingContainer || document;

    // Once per page: the recognizer (two of them, in the worker) takes seconds
    // to load, and is kept warm between visits to drawing mode rather than
    // loaded again -- and leaked -- on each.
    if (!handTracker) {
        handTracker = new HandTracker({
            // CPU, always. MediaPipe's "GPU" delegate is WebGL, not WebGPU,
            // so `navigator.gpu` -- which Chromium defines on any localhost or
            // https page whether or not there is a GPU worth the name -- said
            // nothing about whether to use it, and on a Pi it chose it. There
            // it shares the one weak GPU with rendering: its shaders take ~9 s
            // to compile on the first frame, stalling the page, and every frame
            // after queues behind the scene. The CPU path has a core to itself.
            delegate: "CPU",
            numHands: MAX_HANDS
        });
        handInput = new HandInput(MAX_HANDS);
    }
    await handTracker.init();

    const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';
}

// Puts a point from the camera image into the world: on the camera's ray
// through that spot, so it lands on screen exactly where the fingertip is, at
// a distance set by the fingertip's depth.
//
// It used to be placed on a flat grid at the target's depth and then moved
// toward or away from the camera by that depth -- which, seen through the
// perspective camera, also moved it across the screen, outward or inward in
// proportion to its distance from the centre. The recognizer's depth is the
// noisiest thing it reports, so every stroke wobbled with it, worst at the
// edges, and the drawing on screen sat a few percent larger than the hand's
// path. The grid also assumed the camera was where it starts; orbiting it
// (alt-drag, WASD) put hands somewhere else entirely.
const _viewAxis = new THREE.Vector3();
function placeHandPoint(x, y, z, target) {
    // The webcam faces the user, so its image is mirrored.
    target.set(1 - 2 * x, 1 - 2 * y, 0.5).unproject(camera).sub(camera.position).normalize();
    camera.getWorldDirection(_viewAxis);
    const along = Math.max(0.5, cameraRadius + z * HAND_DEPTH_SCALE);
    return target.multiplyScalar(along / Math.max(0.1, target.dot(_viewAxis))).add(camera.position);
}

function initThreeJS() {
    const container = window._drawingContainer || document.body;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    // Set up camera (position set by updateCameraFromSpherical)
    camera = new THREE.PerspectiveCamera(75, DRAW_ASPECT, 0.1, 1000);

    // Set up renderer (sized by applyRenderSize, below)
    renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    // Don't append here - startDrawingMode will handle it

    // VHSC post-processing: render the scene into a texture, then draw it to
    // the screen through the blur→sharpen→posterize chain.
    vhscPass = createVHSCPass(1, 1);
    applyRenderSize();

    // Add some lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(0, 5, 5);
    scene.add(directionalLight);

    labelsContainer = container.querySelector('#labels-container') || document.getElementById('labels-container');

    // Create World Node and test cubes
    worldNode = new THREE.Group();
    scene.add(worldNode);

    const showOrientationObjects = false;

    const cubeGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);

    // Center cube
    const matCenter = new THREE.MeshPhongMaterial({ color: 0x00ff00, transparent: true });
    const cubeCenter = new THREE.Mesh(cubeGeo, matCenter);
    if (showOrientationObjects) worldNode.add(cubeCenter);

    // Right pyramid (pointing right)
    const pyramidGeo = new THREE.ConeGeometry(0.3, 0.5, 4);
    const matRight = new THREE.MeshPhongMaterial({ color: 0xff0000, transparent: true });
    const pyramidRight = new THREE.Mesh(pyramidGeo, matRight);
    pyramidRight.position.set(2, 0, 0);
    pyramidRight.rotation.z = -Math.PI / 2; // Rotate to point right
    if (showOrientationObjects) worldNode.add(pyramidRight);

    // Top pyramid (pointing up)
    const matTop = new THREE.MeshPhongMaterial({ color: 0x0000ff, transparent: true });
    const pyramidTop = new THREE.Mesh(pyramidGeo, matTop);
    pyramidTop.position.set(0, 2, 0);
    if (showOrientationObjects) worldNode.add(pyramidTop);

    // Store orientation objects for fade effect
    orientationObjects = [];
    if (showOrientationObjects) {
        orientationObjects = [
            { mesh: cubeCenter, material: matCenter },
            { mesh: pyramidRight, material: matRight },
            { mesh: pyramidTop, material: matTop }
        ];
    }
    orientationFadeStart = performance.now();

    // Create meshes and controllers for hands
    const geometry = new THREE.SphereGeometry(0.2, 32, 32);
    for (let i = 0; i < MAX_HANDS; i++) {
        const material = new THREE.MeshPhongMaterial({ color: 0xffffff });
        const mesh = new THREE.Mesh(geometry, material);

        // Create color rim around the sphere
        const rimGeo = new THREE.RingGeometry(0.22, 0.28, 32);
        const rimMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.renderOrder = 998;
        controllerColorRims.push(rim);

        const controller = new Controller();
        controller.placement = placeHandPoint;
        controller.visible = false; // Hide by default
        controller.add(mesh); // Attach the visual indicator to the controller
        controller.add(rim); // Attach the color rim

        scene.add(controller);

        pointerMeshes.push(mesh);
        controllers.push(controller);

        // Create palette for this controller
        const palette = new Palette(paletteRadius, paletteSwatchSize);
        palette.visible = false;
        scene.add(palette);
        palettes.push(palette);
        paletteGripStartTime.push(null);
        paletteVisible.push(false);
        paletteSpawned.push(false);
        paletteSpawnPos.push(new THREE.Vector3());
        paletteFlickerStart.push(null);
        paletteFlickerIndex.push(-1);
        controllerDrawColor.push(0xffffff); // Default white

        // Create line from palette to controller
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(), new THREE.Vector3()
        ]);
        const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
        const paletteLine = new THREE.Line(lineGeo, lineMat);
        paletteLine.visible = false;
        paletteLine.frustumCulled = false;
        scene.add(paletteLine);
        paletteLines.push(paletteLine);

        // Create HTML labels for 3D coordinates and gesture text
        const labelDiv = document.createElement('div');
        labelDiv.className = 'label';
        setDisplay(labelDiv, 'none');
        
        const mainText = document.createElement('div');
        const subText = document.createElement('div');
        subText.className = 'label-small';
        
        labelDiv.appendChild(mainText);
        labelDiv.appendChild(subText);
        labelsContainer.appendChild(labelDiv);
        
        labels.push({
            container: labelDiv,
            main: mainText,
            sub: subText
        });
    }

    // Initialize the world scale logic with our two controllers and the world group
    worldScale = new OpenXR_WorldScale(controllers[0], controllers[1], worldNode);
    frame = new Frame(worldNode);

    attractMode = new AttractMode(frame, worldNode, resetCamera);

    // Initialize mouse controller
    mouseController = new MouseController();
    mouseController.setDrawPlaneDistance(5); // Fixed distance from camera
    scene.add(mouseController);

    // Create palette for mouse controller
    mousePalette = new Palette(0.6, 0.08);
    mousePalette.visible = false;
    scene.add(mousePalette);

    // Initialize undo/reset overlay
    undoOverlay = container.querySelector('#reset-overlay') || document.getElementById('reset-overlay');
    undoCircleLeft = container.querySelector('#reset-circle-left') || document.getElementById('reset-circle-left');
    undoCircleRight = container.querySelector('#reset-circle-right') || document.getElementById('reset-circle-right');
    if (undoCircleLeft) {
        undoCircleLeft.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        undoCircleLeft.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }
    if (undoCircleRight) {
        undoCircleRight.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        undoCircleRight.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }

    // Initialize confirm (green) overlay
    confirmOverlay = container.querySelector('#confirm-overlay') || document.getElementById('confirm-overlay');
    confirmCircleLeft = container.querySelector('#confirm-circle-left') || document.getElementById('confirm-circle-left');
    confirmCircleRight = container.querySelector('#confirm-circle-right') || document.getElementById('confirm-circle-right');
    if (confirmCircleLeft) {
        confirmCircleLeft.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        confirmCircleLeft.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }
    if (confirmCircleRight) {
        confirmCircleRight.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        confirmCircleRight.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }

    drawingStatusEl = container.querySelector('#drawing-status') || document.getElementById('drawing-status');
    gestureCardEl = container.querySelector('#gesture-card') || document.getElementById('gesture-card');

    window.addEventListener('resize', onWindowResize, false);

    // Keyboard controls
    window.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('keyup', onKeyUp, false);

    // Mouse controls
    window.addEventListener('mousedown', onMouseDown, false);
    window.addEventListener('mouseup', onMouseUp, false);
    window.addEventListener('mousemove', onMouseMove, false);
    window.addEventListener('wheel', onMouseWheel, false);

    // Initialize camera position from spherical coordinates
    updateCameraFromSpherical();
}

function onWindowResize() {
    camera.aspect = DRAW_ASPECT;
    camera.updateProjectionMatrix();
    applyRenderSize();
}

// ── Render scale ──
// The canvas fills the 4:3 box on screen, but what is rendered into it can be
// smaller and scaled up by the browser: the VHSC pass costs every pixel five
// texture reads, and on a Raspberry Pi 4 at 1440x1080 that alone is ~15 ms, a
// whole frame at 60 Hz before anything is drawn. So when frames run long the
// scale drops a step, and stays down only if that made them faster -- they can
// be slow for reasons resolution has nothing to do with, and then it goes back
// up and leaves it a while before trying again. It climbs back a step at a
// time when there is room. A machine that keeps up never leaves 1; the lowest
// step still renders more pixels than the 640x480 the drawing is made in.
const RENDER_SCALES = [1, 0.85, 0.7, 0.6, 0.5];
let renderScaleIndex = 0;
const frameIntervals = [];      // ms between frames, this second
let lastFrameAt = 0;
let nextScaleCheck = 0;
let refreshMs = Infinity;       // the display's frame interval, as observed
let scaleTrial = null;          // {before} while a step down is on trial
let scaleDownAfter = 0;         // no stepping down before this
let scaleDownBackoff = 15000;   // doubled each time a step down doesn't help
let scaleUpAfter = 0;           // no stepping up before this
let scaleUpBackoff = 10000;     // doubled each time a step up has to be undone
let lastScaleUpAt = -Infinity;
let calmChecks = 0;

function applyRenderSize() {
    const size = getDrawSize();
    const scale = Math.min(window.devicePixelRatio, 1.0) * RENDER_SCALES[renderScaleIndex];
    const w = Math.max(1, Math.round(size.w * scale));
    const h = Math.max(1, Math.round(size.h * scale));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = size.w + 'px';
    renderer.domElement.style.height = size.h + 'px';
    if (vhscPass) vhscPass.renderTarget.setSize(w, h);
}

function resetFrameStats() {
    frameIntervals.length = 0;
    lastFrameAt = 0;
    scaleTrial = null;
    nextScaleCheck = performance.now() + 2000; // let the page settle first
}

function setRenderScale(index) {
    renderScaleIndex = index;
    applyRenderSize();
}

function trackFrame(now) {
    if (lastFrameAt) {
        const interval = now - lastFrameAt;
        // A stall -- a tab switch, a garbage collection -- says nothing about load.
        if (interval < 250) frameIntervals.push(interval);
    }
    lastFrameAt = now;
    if (now < nextScaleCheck) return;
    nextScaleCheck = now + 1000;
    if (frameIntervals.length < 10) return;

    const sorted = frameIntervals.slice().sort((a, b) => a - b);
    frameIntervals.length = 0;
    refreshMs = Math.max(6, Math.min(refreshMs, sorted[Math.floor(sorted.length * 0.1)]));
    const interval = sorted[sorted.length >> 1];
    const slow = interval > refreshMs * 1.3;

    if (scaleTrial) {
        // A second at the lower scale: keep it if frames came faster.
        if (interval > scaleTrial.before * 0.85) {
            setRenderScale(renderScaleIndex - 1);
            scaleDownAfter = now + scaleDownBackoff;
            scaleDownBackoff = Math.min(scaleDownBackoff * 2, 300000);
        } else {
            scaleDownBackoff = 15000;
        }
        scaleTrial = null;
        calmChecks = 0;
        return;
    }

    if (slow) {
        calmChecks = 0;
        if (renderScaleIndex < RENDER_SCALES.length - 1 && now >= scaleDownAfter) {
            // Climbed too far last time: wait longer before climbing again.
            if (now - lastScaleUpAt < 5000) scaleUpBackoff = Math.min(scaleUpBackoff * 2, 160000);
            scaleUpAfter = now + scaleUpBackoff;
            scaleTrial = { before: interval };
            setRenderScale(renderScaleIndex + 1);
        }
    } else if (interval < refreshMs * 1.1) {
        if (++calmChecks >= 3 && renderScaleIndex > 0 && now >= scaleUpAfter) {
            calmChecks = 0;
            lastScaleUpAt = now;
            setRenderScale(renderScaleIndex - 1);
        }
    } else {
        calmChecks = 0;
    }
}

// Keyboard handlers
function onKeyDown(event) {
    keysPressed[event.key.toLowerCase()] = true;
}

function onKeyUp(event) {
    keysPressed[event.key.toLowerCase()] = false;
}

// Mouse handlers
function onMouseDown(event) {
    if (event.altKey) {
        isMouseActive = true;
        lastMouseX = event.clientX;
        lastMouseY = event.clientY;
    }
}

function onMouseUp(event) {
    isMouseActive = false;
}

function onMouseMove(event) {
    if (!isMouseActive || !event.altKey) {
        isMouseActive = false;
        return;
    }

    const deltaX = event.clientX - lastMouseX;
    const deltaY = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    if (event.shiftKey) {
        // Alt + Shift + mouse = pan
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        camera.getWorldDirection(up);
        right.crossVectors(up, camera.up).normalize();
        up.crossVectors(right, camera.getWorldDirection(new THREE.Vector3())).normalize();

        cameraTarget.addScaledVector(right, -deltaX * panSensitivity);
        cameraTarget.addScaledVector(up, deltaY * panSensitivity);
    } else {
        // Alt + mouse = rotate (orbit)
        cameraTheta += deltaX * mouseSensitivity;
        cameraPhi -= deltaY * mouseSensitivity;

        // Clamp theta to 180-degree hemisphere (front-facing, 0 to PI)
        //cameraTheta = Math.max(0, Math.min(Math.PI, cameraTheta));

        // Clamp phi to avoid flipping
        cameraPhi = Math.max(0.1, Math.min(Math.PI - 0.1, cameraPhi));
    }

    updateCameraFromSpherical();
}

function onMouseWheel(event) {
    // Scroll wheel = zoom
    cameraRadius += event.deltaY * zoomSensitivity * cameraRadius;
    cameraRadius = Math.max(0.5, Math.min(50, cameraRadius));
    updateCameraFromSpherical();
}

function updateCameraFromSpherical() {
    // Convert spherical to Cartesian
    camera.position.x = cameraTarget.x + cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);
    camera.position.y = cameraTarget.y + cameraRadius * Math.cos(cameraPhi);
    camera.position.z = cameraTarget.z + cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
    camera.lookAt(cameraTarget);
}

function resetCamera() {
    cameraRadius = 5;
    cameraTheta = Math.PI / 2;
    cameraPhi = Math.PI / 2;
    cameraTarget.set(0, 0, 0);
    updateCameraFromSpherical();
}

function updateKeyboardNavigation() {
    if (!keysPressed['w'] && !keysPressed['a'] && !keysPressed['s'] && !keysPressed['d'] &&
        !keysPressed['q'] && !keysPressed['e']) {
        return;
    }

    // Get camera forward and right vectors (projected onto XZ plane)
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, camera.up).normalize();

    const movement = new THREE.Vector3();

    if (keysPressed['w']) movement.addScaledVector(forward, moveSpeed);
    if (keysPressed['s']) movement.addScaledVector(forward, -moveSpeed);
    if (keysPressed['a']) movement.addScaledVector(right, -moveSpeed);
    if (keysPressed['d']) movement.addScaledVector(right, moveSpeed);
    if (keysPressed['q']) movement.y -= moveSpeed;
    if (keysPressed['e']) movement.y += moveSpeed;

    cameraTarget.add(movement);
    updateCameraFromSpherical();
}

async function setupWebcam() {
    const container = window._drawingContainer || document;
    video = container.querySelector('#webcam') || document.getElementById('webcam');
    video.style.display = 'none'; // Hide the actual video element

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240 }
        });
        if (!isRunning) {
            // Drawing mode was left while the camera was being asked for.
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        // ...or left and entered again, so an earlier request got here first.
        if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = stream;
        // Wait for video to be ready
        await new Promise(resolve => {
            video.addEventListener('loadeddata', resolve, { once: true });
        });
        if (isRunning && handTracker) handTracker.attach(video);
        // Hide loading message
        const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
        if (loadingEl) loadingEl.style.display = 'none';
    } catch (err) {
        console.error("Error accessing webcam:", err);
        const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
        if (loadingEl) loadingEl.innerText = "Error accessing webcam.";
    }
}

// One recognizer result: which hand is which, then each controller's filters,
// signs and buttons, then the strokes they start, extend and end.
function processHands(result) {
    const hands = handInput.assign(result);
    const edges = controllers.map((c, i) => c.measure(result.t, hands[i]));

    if (attractMode) {
        const anyDown = controllers.some(c =>
            c.trigger_Down || c.grip_Down || c.buttonA_Down || c.buttonB_Down || c.buttonC_Down);
        if (anyDown) {
            if (attractMode.active) attractMode.interrupt();
            attractMode.resetTimer();
        }
    }

    for (let i = 0; i < MAX_HANDS; i++) {
        driveHandStrokes(i, controllers[i], edges[i], hands[i] !== null && hands[i] !== 'lost');
    }
    // While a hand is mid-stroke the tracker keeps to the single-hand
    // recognizer, which samples it twice as often.
    handTracker.drawing = controllers.some(c => c.trigger_Held || c.buttonC_Held);
}

// Each hand draws lines with its trigger (one finger) and filled shapes with
// button C (two fingers), independently. A stroke is cut where the sign that
// ended it began, and starts where the sign that started it began -- the
// controller keeps its recent path for that -- so the moments spent making
// sure of a sign cost the drawing nothing.
function driveHandStrokes(i, controller, edges, seen) {
    const lineId = i;
    const fillId = 'v' + i;

    // Ends first: switching from one tool to the other ends one stroke and
    // starts the other on the same result.
    if (edges.triggerUp && frame.hasActiveStroke(lineId)) frame.endStroke(lineId, controller.triggerCut);
    if (edges.cUp && frame.hasActiveStroke(fillId)) frame.endStroke(fillId, controller.buttonCCut);

    if (edges.triggerDown) {
        beginStrokeFromHistory(controller, lineId, controller.triggerFrom, controllerDrawColor[i], false);
    } else if (seen && controller.trigger_Held && frame.hasActiveStroke(lineId)) {
        frame.continueStroke(controller.getDrawPosition(_drawPos), lineId, controller.sampleTime);
    }

    if (edges.cDown) {
        beginStrokeFromHistory(controller, fillId, controller.buttonCFrom, controllerDrawColor[i], true);
    } else if (seen && controller.buttonC_Held && frame.hasActiveStroke(fillId)) {
        frame.continueStroke(controller.getDrawPosition(_drawPos), fillId, controller.sampleTime);
    }
}

function beginStrokeFromHistory(controller, id, from, color, closed) {
    const samples = controller.samplesSince(from);
    const stroke = samples.length
        ? frame.beginStroke(controller.samplePosition(samples[0], _drawPos), id, color, samples[0].t)
        : frame.beginStroke(controller.getDrawPosition(_drawPos), id, color, controller.sampleTime);
    stroke.closed = closed;
    for (let k = 1; k < samples.length; k++) {
        frame.continueStroke(controller.samplePosition(samples[k], _drawPos), id, samples[k].t);
    }
}

// Writes a style only when it changes: the loop visits these every frame, and
// most frames nothing about them has.
function setDisplay(el, value) {
    if (el && el._display !== value) {
        el.style.display = value;
        el._display = value;
    }
}

function setText(el, value) {
    if (el._text !== value) {
        el.textContent = value;
        el._text = value;
    }
}

// When a hold of these hands' sign began, and how far it has run. A hold is
// timed on what the camera saw: from the first sight of the sign -- so the
// moments spent making sure of it count -- to now, but never more than one
// result past the latest sight of it, so a hand that drops out of view stops
// the clock rather than holding on. It used to start over on any frame the
// sign wasn't read, and one misreading in two seconds is nothing unusual.
// `rearmAt` keeps a hold that has just fired from counting its own past again.
function holdSpan(held, rearmAt, now) {
    let start = Infinity;
    let seen = -Infinity;
    for (const c of held) {
        start = Math.min(start, c.gesture.since);
        seen = Math.max(seen, c.lastSeen);
    }
    const interval = handTracker ? handTracker.interval : 0;
    return { start: Math.max(start, rearmAt), seen: Math.min(now, seen + interval) };
}

// A one-handed hold that has filled waits -- up to PARTNER_WAIT -- while
// another hand in view is making the same sign but hasn't been believed yet:
// two thumbs rarely read as thumbs on the same result, and firing the
// one-handed action (recentre, undo) the moment the first filled took away the
// two-handed one (mint, delete all) the user was halfway through making.
const PARTNER_WAIT = 1500;
function waitForPartner(doneAt, now, sign, heldKey) {
    if (now - doneAt >= PARTNER_WAIT) return false;
    return controllers.some(c => c.present && !c[heldKey] &&
        (c.rawGesture === sign || c.gesture.candidate === sign));
}

function updateHandLabel(label, controller) {
    setDisplay(label.container, 'block');
    const handLabel = controller.handedness === 'Left' ? 'Right' : 'Left'; // Mirrored for user
    setText(label.main, `${handLabel}: ${controller.sign || controller.rawGesture}`);
    const w = controller.tipWorld;
    setText(label.sub, w ? `3D World: ${w[0].toFixed(2)}, ${w[1].toFixed(2)}, ${w[2].toFixed(2)}` : '');

    // Position label on screen by converting 3D position back to 2D.
    // Map NDC onto the centered 4:3 canvas (offset by the letterbox bars).
    const screenPos = _labelPos.copy(controller.position).project(camera);
    const drawSize = getDrawSize();
    const x = drawSize.offsetX + (screenPos.x * .5 + .5) * drawSize.w;
    const y = drawSize.offsetY + (screenPos.y * -.5 + .5) * drawSize.h;
    label.container.style.left = `${x}px`;
    label.container.style.top = `${y - 40}px`; // Offset above the sphere
}
const _labelPos = new THREE.Vector3();

// Track animation frame for cleanup
let animationFrameId = null;
let isRunning = false;
let drawingSession = 0; // counts entries, so a slow setup can tell it is stale

// Main animation loop
function animateLoop() {
    if (!isRunning) return;
    animationFrameId = requestAnimationFrame(animateLoop);
    const frameStart = performance.now();
    const dt = lastFrameAt ? Math.min(100, frameStart - lastFrameAt) : 16;

    // Update keyboard navigation (WASD)
    updateKeyboardNavigation();
    // Hands are placed along camera rays, so the camera has to be current.
    camera.updateMatrixWorld();

    for (const controller of controllers) controller.beginFrame();

    // Hand tracking: whatever results the recognizer has finished since the
    // last frame, oldest first. Each is a measurement, and it is taken exactly
    // once -- strokes grow by one sample per result, not per frame.
    if (handTracker) {
        handTracker.pump();
        for (const result of handTracker.take()) processHands(result);
    }

    // Pointers, eased between results so they glide rather than jump.
    const handInterval = handTracker ? handTracker.interval : 33;
    const chromeVisible = !document.body.classList.contains('ui-hidden');
    for (let i = 0; i < MAX_HANDS; i++) {
        const controller = controllers[i];
        const label = labels[i];
        controller.visible = controller.present;
        if (!controller.present) {
            setDisplay(label.container, 'none');
            continue;
        }
        controller.tick(dt, handInterval);

        // Make rim face the camera
        controllerColorRims[i].lookAt(camera.position);

        // Colour by sign: red for the grip, green for an open hand
        const sign = controller.sign;
        pointerMeshes[i].material.color.setHex(
            sign === 'Closed_Fist' ? 0xff0000 : sign === 'Open_Palm' ? 0x00ff00 : 0xffffff);

        // Slightly scale mesh based on depth
        pointerMeshes[i].scale.setScalar(Math.max(0.1, 1 - controller.depth * 2));

        // Labels are part of the chrome, and hidden with it; only spend
        // layout on them when they can be seen.
        if (chromeVisible) updateHandLabel(label, controller);
        else setDisplay(label.container, 'none');
    }

    // Interrupt attract mode on any user input (hand signs are handled as
    // they arrive, in processHands, so the drawing is cleared before a
    // stroke starts rather than after)
    if (attractMode) {
        if (mouseController && mouseController.trigger_Down) {
            if (attractMode.active) attractMode.interrupt();
            attractMode.resetTimer();
        }
        const anyHeld = controllers.some(c =>
            c.trigger_Held || c.grip_Held || c.buttonA_Held || c.buttonB_Held || c.buttonC_Held
        ) || (mouseController && mouseController.trigger_Held) ||
            Object.values(keysPressed).some(v => v);
        if (anyHeld) attractMode.resetTimer();
    }

    // Mouse controller update and drawing
    if (mouseController) {
        mouseController.update(camera);

        // Right click toggles palette
        if (mouseController.checkRightClick()) {
            if (mousePaletteVisible) {
                // Dismiss palette
                mousePalette.visible = false;
                mousePaletteVisible = false;
                mouseController.paletteActive = false;
            } else {
                // Show palette at mouse position
                mousePalette.position.copy(mouseController.position);
                mousePalette.lookAt(camera.position);
                mousePalette.visible = true;
                mousePaletteVisible = true;
                mouseController.paletteActive = true;
                mouseController.paletteJustOpened = true;
            }
        }

        // Handle palette color selection on left click
        if (mousePaletteVisible && mouseController.isLeftDown && !mouseController.paletteJustOpened) {
            // Check if mouse is over a color
            if (mousePalette.hitTest(mouseController.position, 0.1)) {
                const selectedColor = mousePalette.colors[mousePalette.selectedIndex].hex;
                mouseDrawColor = selectedColor;
                mouseController.setColor(selectedColor);
                // Also update hand controller colors
                for (let j = 0; j < MAX_HANDS; j++) {
                    controllerDrawColor[j] = selectedColor;
                    controllerColorRims[j].material.color.setHex(selectedColor);
                }
                // Dismiss palette
                mousePalette.visible = false;
                mousePaletteVisible = false;
                mouseController.paletteActive = false;
            }
        }

        // Reset paletteJustOpened on mouse up
        if (!mouseController.isLeftDown) {
            mouseController.paletteJustOpened = false;
        }

        // Drawing with mouse (only when palette not active)
        if (!mousePaletteVisible) {
            const mouseVId = 'v_mouse';
            const spaceHeld = !!keysPressed[' '];

            if (spaceHeld) {
                // Space held: left click draws closed filled polygons
                if (mouseController.trigger_Down) {
                    const pos = _drawPos;
                    mouseController.getDrawPosition(pos);
                    const stroke = frame.beginStroke(pos, mouseVId, mouseDrawColor);
                    stroke.closed = true;
                } else if (mouseController.trigger_Held && frame.hasActiveStroke(mouseVId)) {
                    const pos = _drawPos;
                    mouseController.getDrawPosition(pos);
                    frame.continueStroke(pos, mouseVId);
                } else if (mouseController.trigger_Up) {
                    frame.endStroke(mouseVId);
                }
            } else {
                // No space: normal brush strokes
                if (frame.hasActiveStroke(mouseVId)) frame.endStroke(mouseVId);
                if (mouseController.trigger_Down) {
                    const pos = _drawPos;
                    mouseController.getDrawPosition(pos);
                    frame.beginStroke(pos, MOUSE_CONTROLLER_ID, mouseDrawColor);
                } else if (mouseController.trigger_Held && frame.hasActiveStroke(MOUSE_CONTROLLER_ID)) {
                    const pos = _drawPos;
                    mouseController.getDrawPosition(pos);
                    frame.continueStroke(pos, MOUSE_CONTROLLER_ID);
                } else if (mouseController.trigger_Up) {
                    frame.endStroke(MOUSE_CONTROLLER_ID);
                }
            }
        }
    }

    // Palette logic for each controller
    const now = performance.now();
    for (let i = 0; i < MAX_HANDS; i++) {
        const controller = controllers[i];
        const palette = palettes[i];
        const paletteLine = paletteLines[i];

        // Handle flicker phase (color selected)
        if (paletteFlickerStart[i] !== null) {
            const flickerElapsed = now - paletteFlickerStart[i];
            if (flickerElapsed < PALETTE_FLICKER_DURATION) {
                // Flicker the selected swatch
                const flickerOn = Math.floor(flickerElapsed / 50) % 2 === 0;
                const selectedSwatch = palette.swatches[paletteFlickerIndex[i]];
                if (selectedSwatch) {
                    selectedSwatch.visible = flickerOn;
                }
            } else {
                // Flicker done - set the color and hide palette
                const newColor = palette.colors[paletteFlickerIndex[i]].hex;
                // Update color for ALL controllers (shared color)
                for (let j = 0; j < MAX_HANDS; j++) {
                    controllerDrawColor[j] = newColor;
                    controllerColorRims[j].material.color.setHex(newColor);
                }
                // Also update mouse controller color
                mouseDrawColor = newColor;
                mouseController.setColor(newColor);
                palette.visible = false;
                paletteLine.visible = false;
                paletteVisible[i] = false;
                paletteFlickerStart[i] = null;
                paletteFlickerIndex[i] = -1;
                paletteGripStartTime[i] = null;
                // Restore all swatch visibility
                for (const swatch of palette.swatches) {
                    swatch.visible = true;
                }
            }
            continue;
        }

        // Check grip state
        if (controller.grip_Held && controller.visible) {
            // Start tracking grip time if not already
            if (paletteGripStartTime[i] === null) {
                paletteGripStartTime[i] = now;
            }

            const gripElapsed = now - paletteGripStartTime[i];
            const halfDuration = PALETTE_HOLD_DURATION / 1.33; //2;

            // Flicker preview at 50%, fully visible at 100%
            if (gripElapsed >= halfDuration && !paletteVisible[i]) {
                const otherGrip = controllers[(i + 1) % MAX_HANDS].grip_Held;
                if (!otherGrip) {
                    if (!paletteSpawned[i]) {
                        const pos = _drawPos;
                        controller.getWorldPosition(pos);
                        paletteSpawnPos[i].copy(pos);
                        palette.position.copy(pos);
                        palette.lookAt(camera.position);
                        paletteSpawned[i] = true;
                    }

                    if (gripElapsed < PALETTE_HOLD_DURATION) {
                        palette.visible = Math.floor(now / 50) % 2 === 0;
                    } else {
                        paletteVisible[i] = true;
                        palette.visible = true;
                        paletteLine.visible = true;
                    }
                }
            }

            // Update palette line and check for color hits
            if (paletteVisible[i]) {
                const controllerPos = new THREE.Vector3();
                controller.getWorldPosition(controllerPos);

                // Update line from palette center to controller
                const positions = paletteLine.geometry.attributes.position.array;
                positions[0] = paletteSpawnPos[i].x;
                positions[1] = paletteSpawnPos[i].y;
                positions[2] = paletteSpawnPos[i].z;
                positions[3] = controllerPos.x;
                positions[4] = controllerPos.y;
                positions[5] = controllerPos.z;
                paletteLine.geometry.attributes.position.needsUpdate = true;

                // Check if controller touches a color
                if (palette.hitTest(controllerPos, 0.05)) {
                    // Hide other swatches, start flicker
                    const selectedIdx = palette.selectedIndex;
                    for (let j = 0; j < palette.swatches.length; j++) {
                        palette.swatches[j].visible = (j === selectedIdx);
                    }
                    palette.selectionRing.visible = false;
                    paletteLine.visible = false;
                    paletteFlickerStart[i] = now;
                    paletteFlickerIndex[i] = selectedIdx;
                }
            }
        } else {
            // Grip released - hide palette
            if ((paletteVisible[i] || paletteSpawned[i]) && paletteFlickerStart[i] === null) {
                palette.visible = false;
                paletteLine.visible = false;
                paletteVisible[i] = false;
                paletteSpawned[i] = false;
                // Restore all swatch visibility
                for (const swatch of palette.swatches) {
                    swatch.visible = true;
                }
                palette.selectionRing.visible = true;
            }
            paletteGripStartTime[i] = null;
        }
    }

    // Double buttonC (Victory gesture) = instant full reset (buttons, camera, world)
    // Commented out: V gesture is now used for drawing instead.
    // const bothButtonC = controllers.every(c => c.buttonC_Held);
    // if (bothButtonC) {
    //     // Reset all button states on both controllers
    //     for (const controller of controllers) {
    //         controller.grip_Down = false;
    //         controller.grip_Held = false;
    //         controller.trigger_Down = false;
    //         controller.trigger_Held = false;
    //         controller.trigger_Up = false;
    //         controller.buttonA_Down = false;
    //         controller.buttonA_Held = false;
    //         controller.buttonB_Down = false;
    //         controller.buttonB_Held = false;
    //         controller.buttonC_Down = false;
    //         controller.buttonC_Held = false;
    //     }
    //     // Reset camera
    //     resetCamera();
    //     // Reset world origin
    //     worldNode.position.set(0, 0, 0);
    //     worldNode.quaternion.identity();
    //     worldNode.scale.set(1, 1, 1);
    //     // Reset undo/reset timer state
    //     undoHoldStart = null;
    //     undoFlickerStart = null;
    //     pendingAction = null;
    //     undoOverlay.style.display = 'none';
    //     undoCircleLeft.style.display = 'none';
    //     undoCircleRight.style.display = 'none';
    //     // Reset orientation objects fade
    //     orientationFadeStart = now;
    //     for (const obj of orientationObjects) {
    //         obj.material.opacity = 1;
    //     }
    // }

    // Undo/Reset logic with hold timer and shrinking circle
    const buttonBCount = controllers.filter(c => c.buttonB_Held).length;
    const bothButtonBHeld = buttonBCount === 2;
    const singleButtonBHeld = buttonBCount === 1;

    // Helper to position circles based on action type
    const updateCirclePositions = (scale, isReset) => {
        const offset = isReset ? (UNDO_CIRCLE_MAX_SIZE * UNDO_CIRCLE_SPACING) / 2 : 0;
        // Center the circles vertically and position horizontally
        const baseTransform = `translate(-50%, -50%) scale(${scale})`;
        if (isReset) {
            // Two circles side by side
            undoCircleLeft.style.transform = `translate(calc(-50% - ${offset}px), -50%) scale(${scale})`;
            undoCircleRight.style.transform = `translate(calc(-50% + ${offset}px), -50%) scale(${scale})`;
            setDisplay(undoCircleLeft, 'block');
            setDisplay(undoCircleRight, 'block');
        } else {
            // Single centered circle (use left circle only)
            undoCircleLeft.style.transform = baseTransform;
            setDisplay(undoCircleLeft, 'block');
            setDisplay(undoCircleRight, 'none');
        }
    };

    // Handle flicker phase
    if (undoFlickerStart !== null) {
        const flickerElapsed = now - undoFlickerStart;
        if (flickerElapsed < UNDO_FLICKER_DURATION) {
            // Flicker on/off every 50ms
            const flickerOn = Math.floor(flickerElapsed / 50) % 2 === 0;
            setDisplay(undoOverlay, flickerOn ? 'block' : 'none');
            if (flickerOn) {
                updateCirclePositions(UNDO_CIRCLE_MIN_SCALE, pendingAction === 'reset');
            }
        } else {
            // Flicker done - action already performed by Frame flicker methods
            const wasReset = pendingAction === 'reset';
            setDisplay(undoOverlay, 'none');
            setDisplay(undoCircleLeft, 'none');
            setDisplay(undoCircleRight, 'none');
            undoFlickerStart = null;
            undoHoldStart = null;
            pendingAction = null;
            // The buttons follow the hands' signs, so there is nothing to
            // reset: a thumb still down starts a fresh hold from here.
            undoRearmAt = now;
            // Reset orientation objects fade if this was a full reset
            if (wasReset) {
                orientationFadeStart = now;
                for (const obj of orientationObjects) {
                    obj.material.opacity = 1;
                }
            }
        }
    }
    // Handle hold countdown phase
    else if (bothButtonBHeld || singleButtonBHeld) {
        // Determine action: both = reset, single = undo
        // If it switches from single to both during hold, upgrade to reset
        const currentAction = bothButtonBHeld ? 'reset' : 'undo';

        const span = holdSpan(controllers.filter(c => c.buttonB_Held), undoRearmAt, now);
        if (undoHoldStart === null) {
            undoHoldStart = span.start;
            pendingAction = currentAction;
        } else if (currentAction === 'reset') {
            // Upgrade to reset if both are now held
            pendingAction = 'reset';
        }

        const holdElapsed = span.seen - undoHoldStart;
        const progress = Math.max(0, Math.min(holdElapsed / UNDO_HOLD_DURATION, 1));

        // Show and shrink circle(s)
        setDisplay(undoOverlay, 'block');
        const scale = 1 - progress * (1 - UNDO_CIRCLE_MIN_SCALE);
        updateCirclePositions(scale, pendingAction === 'reset');

        // Timer complete - start flicker for both circle and strokes
        if (progress >= 1 && pendingAction === 'undo' && waitForPartner(undoDoneAt ??= now, now, 'Thumb_Down', 'buttonB_Held')) {
            // A second thumb is on its way: this is a delete-all in the making
        } else if (progress >= 1) {
            undoDoneAt = null;
            undoFlickerStart = now;
            // Start stroke/frame flicker in parallel with circle flicker
            if (pendingAction === 'reset') {
                frame.clearWithFlicker();
                resetCamera();
            } else if (pendingAction === 'undo') {
                frame.undoWithFlicker();
            }
        }
    } else {
        // Button released - cancel action
        if (undoFlickerStart === null) {
            undoHoldStart = null;
            undoDoneAt = null;
            pendingAction = null;
            setDisplay(undoOverlay, 'none');
            setDisplay(undoCircleLeft, 'none');
            setDisplay(undoCircleRight, 'none');
        }
    }

    // Confirm logic (Button A) - green expanding circles with hold timer
    const buttonACount = controllers.filter(c => c.buttonA_Held).length;
    const bothButtonAHeld = buttonACount === 2;
    const singleButtonAHeld = buttonACount === 1;

    // Helper to position confirm circles based on action type
    const updateConfirmCirclePositions = (scale, isDouble) => {
        const offset = isDouble ? (UNDO_CIRCLE_MAX_SIZE * UNDO_CIRCLE_SPACING) / 2 : 0;
        const baseTransform = `translate(-50%, -50%) scale(${scale})`;
        if (isDouble) {
            // Two circles side by side
            if (confirmCircleLeft) {
                confirmCircleLeft.style.transform = `translate(calc(-50% - ${offset}px), -50%) scale(${scale})`;
                setDisplay(confirmCircleLeft, 'block');
            }
            if (confirmCircleRight) {
                confirmCircleRight.style.transform = `translate(calc(-50% + ${offset}px), -50%) scale(${scale})`;
                setDisplay(confirmCircleRight, 'block');
            }
        } else {
            // Single centered circle
            if (confirmCircleLeft) {
                confirmCircleLeft.style.transform = baseTransform;
                setDisplay(confirmCircleLeft, 'block');
            }
            if (confirmCircleRight) {
                setDisplay(confirmCircleRight, 'none');
            }
        }
    };

    // Handle confirm flicker phase
    if (confirmFlickerStart !== null) {
        const flickerElapsed = now - confirmFlickerStart;
        if (flickerElapsed < UNDO_FLICKER_DURATION) {
            // Flicker on/off every 50ms
            const flickerOn = Math.floor(flickerElapsed / 50) % 2 === 0;
            setDisplay(confirmOverlay, flickerOn ? 'block' : 'none');
            if (flickerOn) {
                updateConfirmCirclePositions(1, pendingConfirmAction === 'double');
            }
        } else {
            // Flicker done
            const wasSingle = pendingConfirmAction === 'single';
            setDisplay(confirmOverlay, 'none');
            setDisplay(confirmCircleLeft, 'none');
            setDisplay(confirmCircleRight, 'none');
            confirmFlickerStart = null;
            confirmHoldStart = null;
            pendingConfirmAction = null;
            confirmRearmAt = now;
            // Single Button A = camera reset + world reset + show orientation objects
            if (wasSingle) {
                // Reset camera
                resetCamera();
                // ...and the gestures again with it: a recentred view is where
                // someone who has lost their place starts over.
                showGestureCard();
                // Reset world origin
                worldNode.position.set(0, 0, 0);
                worldNode.quaternion.identity();
                worldNode.scale.set(1, 1, 1);
                // Reset orientation objects fade (make guide cube/pyramids reappear)
                orientationFadeStart = now;
                for (const obj of orientationObjects) {
                    obj.material.opacity = 1;
                }
            } else {
                // Double Button A = mint the drawing to Tezos
                mintDrawing();
            }
        }
    }
    // Handle confirm hold countdown phase (expanding circles)
    else if (bothButtonAHeld || singleButtonAHeld) {
        const currentAction = bothButtonAHeld ? 'double' : 'single';

        const span = holdSpan(controllers.filter(c => c.buttonA_Held), confirmRearmAt, now);
        if (confirmHoldStart === null) {
            confirmHoldStart = span.start;
            pendingConfirmAction = currentAction;
        } else if (currentAction === 'double') {
            // Upgrade to double if both are now held
            pendingConfirmAction = 'double';
        }

        const holdElapsed = span.seen - confirmHoldStart;
        const progress = Math.max(0, Math.min(holdElapsed / UNDO_HOLD_DURATION, 1));

        // Show and expand circle(s) (reverse of shrink)
        setDisplay(confirmOverlay, 'block');
        const scale = UNDO_CIRCLE_MIN_SCALE + progress * (1 - UNDO_CIRCLE_MIN_SCALE);
        updateConfirmCirclePositions(scale, pendingConfirmAction === 'double');

        // Timer complete - start flicker
        if (progress >= 1 && pendingConfirmAction === 'single' && waitForPartner(confirmDoneAt ??= now, now, 'Thumb_Up', 'buttonA_Held')) {
            // A second thumb is on its way: this is a mint in the making
        } else if (progress >= 1) {
            confirmDoneAt = null;
            confirmFlickerStart = now;
        }
    } else {
        // Button released - cancel action
        if (confirmFlickerStart === null) {
            confirmHoldStart = null;
            confirmDoneAt = null;
            pendingConfirmAction = null;
            setDisplay(confirmOverlay, 'none');
            setDisplay(confirmCircleLeft, 'none');
            setDisplay(confirmCircleRight, 'none');
        }
    }

    // Update world scale logic
    if (worldScale) {
        worldScale.update();
    }

    // Update orientation objects fade
    if (orientationFadeStart !== null) {
        const fadeElapsed = now - orientationFadeStart;
        const fadeProgress = Math.min(fadeElapsed / ORIENTATION_FADE_DURATION, 1);
        const opacity = 1 - fadeProgress;

        for (const obj of orientationObjects) {
            obj.material.opacity = opacity;
        }

        if (fadeProgress >= 1) {
            orientationFadeStart = null;
        }
    }

    // Attract mode: draw random NAPLPS files when idle
    if (attractMode) attractMode.update();

    // Strokes being drawn are rebuilt here, once, however many points they
    // gained since the last frame.
    frame.flush();

    // Two-pass render: scene → offscreen target, then VHSC shader → screen.
    if (vhscPass) {
        renderer.setRenderTarget(vhscPass.renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(vhscPass.orthoScene, vhscPass.orthoCamera);
    } else {
        renderer.render(scene, camera);
    }

    trackFrame(frameStart);
}

// Export functions for external control
export function armDelete() {
    _armDelete = true;
}

export async function startDrawingMode(container) {
    if (isRunning) return;
    isRunning = true;
    const session = ++drawingSession;

    // Store reference to container for cleanup
    window._drawingContainer = container;

    // Ask the backend what a token may weigh, without holding drawing mode up
    // for it: NapClient caches the reply, and nothing is encoded until a stroke
    // has been drawn. If the call fails, mintDrawing() asks again.
    loadSizeLimit();

    // Show loading indicator
    const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.innerText = 'Loading MediaPipe...';
    }

    // Initialize if not already done
    if (!renderer) {
        initThreeJS();
    }

    // Always move renderer to the container (handles both first run and re-entry)
    container.appendChild(renderer.domElement);

    // Ensure renderer is sized correctly (4:3, centered within the container)
    if (camera) {
        camera.aspect = DRAW_ASPECT;
        camera.updateProjectionMatrix();
    }
    applyRenderSize();
    resetFrameStats();

    // Update labelsContainer reference for this container
    labelsContainer = container.querySelector('#labels-container') || document.getElementById('labels-container');

    // Re-append existing labels to the correct container (for re-entry)
    if (labels.length > 0 && labelsContainer) {
        labels.forEach(label => {
            if (label.container && label.container.parentNode !== labelsContainer) {
                labelsContainer.appendChild(label.container);
            }
        });
    }

    // Update undo overlay references for this container
    undoOverlay = container.querySelector('#reset-overlay') || document.getElementById('reset-overlay');
    undoCircleLeft = container.querySelector('#reset-circle-left') || document.getElementById('reset-circle-left');
    undoCircleRight = container.querySelector('#reset-circle-right') || document.getElementById('reset-circle-right');
    if (undoCircleLeft) {
        undoCircleLeft.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        undoCircleLeft.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }
    if (undoCircleRight) {
        undoCircleRight.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        undoCircleRight.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }

    // Update confirm overlay references for this container
    confirmOverlay = container.querySelector('#confirm-overlay') || document.getElementById('confirm-overlay');
    confirmCircleLeft = container.querySelector('#confirm-circle-left') || document.getElementById('confirm-circle-left');
    confirmCircleRight = container.querySelector('#confirm-circle-right') || document.getElementById('confirm-circle-right');
    if (confirmCircleLeft) {
        confirmCircleLeft.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        confirmCircleLeft.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }
    if (confirmCircleRight) {
        confirmCircleRight.style.width = UNDO_CIRCLE_MAX_SIZE + 'px';
        confirmCircleRight.style.height = UNDO_CIRCLE_MAX_SIZE + 'px';
    }

    drawingStatusEl = container.querySelector('#drawing-status') || document.getElementById('drawing-status');
    gestureCardEl = container.querySelector('#gesture-card') || document.getElementById('gesture-card');
    hideDrawingStatus(); // whatever the last session ended on shouldn't greet this one

    // The gestures are the only controls this mode has, so every session opens
    // on the chart, whether it is the first or a return from review mode.
    showGestureCard();

    if (attractMode) attractMode.resetTimer();

    // Start rendering before the async setup so the scene is visible
    // immediately — the animate loop runs without hands until the
    // recognizer is ready.
    animateLoop();

    if (_armDelete) {
        _armDelete = false;
        frame.clearWithFlicker();
        resetCamera();
    }

    // The mouse draws from the start; it used to wait for the recognizer,
    // which takes several seconds to load on a Pi and might not load at all.
    if (mouseController) {
        mouseController.enable();
    }

    try {
        await setupMediaPipe();
    } catch (err) {
        console.error('[nap-xtz] hand tracking unavailable:', err);
        const loading = container.querySelector('#loading') || document.getElementById('loading');
        if (loading) loading.innerText = 'Hand tracking unavailable';
        return;
    }
    // Left (and perhaps come back) while the recognizer loaded: this session
    // has nothing more to set up.
    if (session !== drawingSession || !isRunning) return;
    await setupWebcam();
}

export function stopDrawingMode() {
    isRunning = false;

    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    // Convert drawing to NAPLPS before stopping; returns the bytes, or
    // null when there were no strokes — the caller uses this to decide
    // whether to load a chain token instead.
    const hadDrawing = convertToNAPLPS() !== null;

    // Disable mouse controller
    if (mouseController) {
        mouseController.disable();
        // Hide mouse palette if visible
        if (mousePalette) {
            mousePalette.visible = false;
            mousePaletteVisible = false;
            mouseController.paletteActive = false;
        }
    }

    // Stop webcam
    if (handTracker) handTracker.detach();
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    // Let go of the hands, and of any stroke they were halfway through: it
    // wasn't in the drawing just encoded, and the hand won't be where it was
    // when drawing mode next opens.
    for (let i = 0; i < controllers.length; i++) {
        controllers[i].release();
        for (const id of [i, 'v' + i]) {
            if (frame.hasActiveStroke(id)) frame.endStroke(id, -Infinity);
        }
    }

    // Hide labels
    labels.forEach(label => {
        if (label.container) setDisplay(label.container, 'none');
    });

    hideGestureCard(); // the overlay is going, so a fade shouldn't outlive it

    return hadDrawing;
}

// Encodes the current frame to NAPLPS and loads it into the main canvas.
// Returns the encoded bytes, or null if there was nothing to encode -- the
// mint gesture needs to tell an empty frame from a stale window.pendingNapRaw
// left behind by whatever was on the canvas before.
function convertToNAPLPS() {
    if (!frame || !frame.strokes || frame.strokes.length === 0) {
        console.log('No strokes to convert');
        return null;
    }

    // NapInputWrapper, NapEncoder, Vector2, Vector3 are global (from naplps.js)
    if (typeof window.NapInputWrapper === 'undefined' || typeof window.NapEncoder === 'undefined') {
        console.error('NapInputWrapper or NapEncoder not available');
        return null;
    }

    frame.updateWorldMatrix(true, false); // the loop may already be stopped

    // Strokes are kept in the frame's own space, and the frame rides on the node
    // the two-handed gesture moves, so a point has to go through that transform
    // before the camera sees it -- otherwise a drawing that was zoomed or turned
    // encodes in the pose it was drawn in rather than the one on screen.
    const project = (point) => {
        const projected = frame.localToWorld(point.clone()).project(camera);

        // NDC: x=-1 is left, x=1 is right; y=-1 is bottom, y=1 is top
        // NAPLPS: x=0 is left, x=1 is right; y=0 is top, y=1 is bottom
        const nx = (projected.x + 1) / 2;

        // The main canvas renders NAPLPS into a SQUARE 640x640 space, so the
        // 4:3 view's vertical extent must be compressed by 480/640 (= 1/DRAW_ASPECT)
        // and pushed down by the remainder, matching the SVG-import convention
        // (y/sH*0.75 + 0.25). Without this the drawing looks horizontally squeezed.
        const vScale = 1 / DRAW_ASPECT; // 0.75
        const ny = ((1 - projected.y) / 2) * vScale + (1 - vScale); // Flip Y, fit 4:3

        return { x: nx, y: ny };
    };

    // Brush width is measured across the view, so it never depends on which way
    // the stroke happens to face. The camera's right vector, carried back into
    // the frame's space, is that direction where the stroke's points live.
    const toStrokeSpace = new THREE.Matrix3().setFromMatrix4(frame.matrixWorld).invert();
    const widthAxis = new THREE.Vector3()
        .setFromMatrixColumn(camera.matrixWorld, 0)
        .applyMatrix3(toStrokeSpace)
        .normalize();

    // Every stroke's polygons at one simplification tolerance.
    // Fresh Vector2s each time: NapEncoder flips a point's y in
    // place as it encodes, so a second pass over the same objects would come out
    // upside down.
    const buildInput = (epsilon) => {
        const input = [];

        const simplifyIndices = (pts, eps, start, end) => {
                if (end - start < 2) return [start, end];
                let maxDist = 0, maxIdx = start;
                for (let i = start + 1; i < end; i++) {
                    const dx = pts[end].x - pts[start].x, dy = pts[end].y - pts[start].y;
                    const lenSq = dx*dx + dy*dy;
                    let dist = 0;
                    if (lenSq === 0) dist = Math.hypot(pts[i].x - pts[start].x, pts[i].y - pts[start].y);
                    else {
                        const t = Math.max(0, Math.min(1, ((pts[i].x - pts[start].x)*dx + (pts[i].y - pts[start].y)*dy)/lenSq));
                        dist = Math.hypot(pts[i].x - (pts[start].x + t*dx), pts[i].y - (pts[start].y + t*dy));
                    }
                    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
                }
                if (maxDist > eps) {
                    return [...simplifyIndices(pts, eps, start, maxIdx).slice(0, -1), ...simplifyIndices(pts, eps, maxIdx, end)];
                }
                return [start, end];
        };

        for (const stroke of frame.strokes) {
            if (!stroke.points || stroke.points.length < 2) continue;

            const hex = stroke.color || 0xffffff;
            const r = (hex >> 16) & 0xff;
            const g = (hex >> 8) & 0xff;
            const b = hex & 0xff;
            const color = new window.Vector3(r, g, b);

            // Closed strokes: the polyline IS the polygon — no brush expansion.
            if (stroke.closed) {
                const verts = stroke.toScreenPolygon(project);
                if (verts.length < 3) continue;
                const keep = simplifyIndices(verts, epsilon, 0, verts.length - 1);
                const poly = keep.map(idx => new window.Vector2(
                    Math.max(0, Math.min(1, verts[idx].x)),
                    Math.max(0, Math.min(1, verts[idx].y))
                ));
                if (poly.length < 3) continue;
                input.push(new window.NapInputWrapper(color, poly, true));
                continue;
            }

            const { points, radii } = stroke.toScreenPath(project, widthAxis);
            if (points.length < 2) continue;

            const keep = simplifyIndices(points, epsilon, 0, points.length - 1);

            const leftEdge = [];
            const rightEdge = [];

            for (let i = 0; i < keep.length; i++) {
                const idx = keep[i];
                const p = points[idx];
                const rad = Math.max(radii[idx], 0.0005);

                let tX = 0, tY = 0;
                if (i === 0) {
                    const next = points[keep[i+1]];
                    tX = next.x - p.x;
                    tY = next.y - p.y;
                } else if (i === keep.length - 1) {
                    const prev = points[keep[i-1]];
                    tX = p.x - prev.x;
                    tY = p.y - prev.y;
                } else {
                    const next = points[keep[i+1]];
                    const prev = points[keep[i-1]];
                    tX = next.x - prev.x;
                    tY = next.y - prev.y;
                }

                const len = Math.hypot(tX, tY);
                if (len > 1e-8) {
                    tX /= len;
                    tY /= len;
                } else {
                    tX = 1;
                    tY = 0;
                }

                const pX = -tY;
                const pY = tX;

                leftEdge.push(new window.Vector2(
                    Math.max(0, Math.min(1, p.x + pX * rad)),
                    Math.max(0, Math.min(1, p.y + pY * rad))
                ));
                rightEdge.unshift(new window.Vector2(
                    Math.max(0, Math.min(1, p.x - pX * rad)),
                    Math.max(0, Math.min(1, p.y - pY * rad))
                ));
            }

            const points2D = [...leftEdge, ...rightEdge];
            input.push(new window.NapInputWrapper(color, points2D, true));
        }
        return input;
    };
    // enough to fit; whatever room is left then buys the cover runs back.
    //
    // It used to run the other way round -- every drawing paid for the cover run
    // up front, and a busy one paid for it by having its centreline thinned
    // until the polygons lost their shape. Measured against the ideal brush, the
    // tolerance is worth ten to thirty points of fidelity where the cover run is
    // worth none at all: it buys nothing unless a polygon actually goes missing.
    // So the cover run is what gives way when a drawing is too big, not the
    // shape of the strokes.
    //
    // Null until the backend's figure has come (see maxNaplpsBytes), and with no
    // limit there is nothing to fit -- the canvas and the Pi will take whatever
    // this produces, so it gets the finest brush and the cover run too.
    const limit = maxNaplpsBytes;

    let epsilon = BRUSH_SIMPLIFY;
    let input = buildInput(epsilon);

    if (input.length === 0) {
        console.log('No valid strokes to encode');
        return null;
    }

    let encoder = new window.NapEncoder(input);

    // A drawing that won't fit the chain is redrawn with a coarser brush rather
    // than handed over to be refused: the shape survives losing points far
    // better than the drawing survives a mint that never happens.
    for (let pass = 1; pass < MAX_SIMPLIFY_PASSES && limit !== null && encoder.napRaw.length > limit; pass++) {
        // Doubling alone can't leave zero, and zero is a brush tuned to keep
        // every point it was given. Step onto the encoder's own quantum first:
        // the coarsest tolerance that still discards nothing the format could
        // have carried anyway.
        epsilon = Math.max(epsilon * 2, MIN_STEP);
        console.log(`[nap-xtz] ${encoder.napRaw.length} bytes is over the ${limit} limit; ` +
                    `simplifying at ${epsilon.toFixed(4)}`);

        const simpler = buildInput(epsilon);
        if (simpler.length === 0) break; // nothing left to give: keep what we have

        input = simpler;
        encoder = new window.NapEncoder(input);
    }

    if (limit === null) {
        console.warn('[nap-xtz] no size limit from the backend yet -- encoded without fitting it');
    } else if (encoder.napRaw.length > limit) {
        // Encoded anyway: the canvas and the Raspberry Pi will take it even
        // though a mint won't, and the wallet says so in its own words.
        console.warn(`[nap-xtz] drawing is ${encoder.napRaw.length} bytes, still over the ` +
                     `${limit} limit -- too much to mint`);
    }

    // Load into the main canvas
    if (typeof window.loadTelidonFromText === 'function') {
        window.loadTelidonFromText(encoder.napRaw);
    } else {
        console.error('loadTelidonFromText not available');
    }

    console.log(`Converted ${frame.strokes.length} strokes (${input.length} polygons) ` +
                `to ${encoder.napRaw.length} bytes of NAPLPS at tolerance ${epsilon.toFixed(4)}`);
    return encoder.napRaw;
}

// ── Mint gesture (double thumbs-up) ──
// Drawing mode stays up: the strokes are encoded as they stand and handed to
// the wallet shim in js/tezos/tezos.js, which owns signing. The Beacon popup
// renders outside #drawing-container, so the system cursor (hidden inside it,
// see main.css) comes back for the wallet prompt.
let mintInFlight = false;

// The shim's own setStatus writes into #container -- behind this overlay, and
// hidden along with the rest of the chrome -- so the gesture needs a status
// line of its own or it reports only to the console. Pass hold = 0 to leave a
// message up until the next one replaces it.
function showDrawingStatus(text, isError, hold) {
    if (!drawingStatusEl) return;

    drawingStatusEl.textContent = text;
    drawingStatusEl.style.color = isError ? '#ff6666' : '#ffcc00';
    drawingStatusEl.style.display = 'block';

    clearTimeout(drawingStatusTimer);
    drawingStatusTimer = null;
    const ms = hold === undefined ? DRAWING_STATUS_HOLD : hold;
    if (ms > 0) drawingStatusTimer = setTimeout(hideDrawingStatus, ms);
}

function hideDrawingStatus() {
    clearTimeout(drawingStatusTimer);
    drawingStatusTimer = null;
    if (drawingStatusEl) drawingStatusEl.style.display = 'none';
}

// ── Gesture guide card ──
// The hand-sign chart (public/images/hand_gesture_sign.png), up for five
// seconds and then faded out over a second. Drawing mode has no menu and no
// visible chrome, so the chart is how the gestures are learned: it greets every
// session, and a single thumbs-up -- the gesture for "put me back where I
// started" -- brings it up again, since someone recentring the view is usually
// someone who has lost their bearings.
//
// The fade is the stylesheet's (.visible turns the transition off, so raising
// the card is instant and only dropping the class fades it). Showing while a
// fade runs cancels it and starts the five seconds over.
function showGestureCard() {
    if (!gestureCardEl) return;

    clearTimeout(gestureCardFadeTimer);
    clearTimeout(gestureCardHideTimer);
    gestureCardHideTimer = null;

    gestureCardEl.style.display = 'block';
    gestureCardEl.classList.add('visible');

    gestureCardFadeTimer = setTimeout(function() {
        gestureCardFadeTimer = null;
        gestureCardEl.classList.remove('visible'); // the CSS fade, from here
        // display:none only once the fade has run, or it would cut it short.
        gestureCardHideTimer = setTimeout(hideGestureCard, GESTURE_CARD_FADE);
    }, GESTURE_CARD_HOLD);
}

function hideGestureCard() {
    clearTimeout(gestureCardFadeTimer);
    clearTimeout(gestureCardHideTimer);
    gestureCardFadeTimer = null;
    gestureCardHideTimer = null;
    if (!gestureCardEl) return;
    gestureCardEl.classList.remove('visible');
    gestureCardEl.style.display = 'none';
}

async function mintDrawing() {
    if (mintInFlight) return; // a held gesture shouldn't stack wallet prompts
    mintInFlight = true;

    try {
        // The encoding is fitted to the backend's limit, so have it first --
        // normally it came when drawing mode opened, and this costs nothing.
        await loadSizeLimit();

        const napRaw = convertToNAPLPS();
        if (!napRaw) {
            console.warn('[nap-xtz] nothing to mint - draw something first');
            showDrawingStatus('Draw something first', true);
            return;
        }
        if (typeof window.mintCurrentNaplps !== 'function') {
            console.error('[nap-xtz] mintCurrentNaplps not available');
            showDrawingStatus('Minting unavailable', true);
            return;
        }

        // A server-signed mint waits on a confirmation (~15s on Shadownet), so this
        // one stays up rather than timing out halfway through the wait.
        showDrawingStatus('Minting...', false, 0);
        const result = await window.mintCurrentNaplps();
        if (result && result.ok) {
            showDrawingStatus('Minted');
        } else {
            showDrawingStatus('Mint failed: ' + ((result && result.error) || 'unknown error'), true);
        }
    } finally {
        mintInFlight = false;
    }
}

