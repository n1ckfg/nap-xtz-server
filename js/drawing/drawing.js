import * as THREE from 'three';
import { Controller } from './controller.js';
import { MouseController } from './mouse.js';
import { OpenXR_WorldScale } from './worldscale.js';
import { Frame } from './tools.js';
import { Palette } from './palette.js';

let gestureRecognizer;
let video;
let results;
let lastVideoTime = -1;

// Three.js variables
let scene, camera, renderer;
let pointerMeshes = [];
let controllers = [];
let labels = [];
let labelsContainer;

let worldNode;
let worldScale;
let frame;

const MAX_HANDS = 2;

// Reused scratch vector for per-frame draw-position reads (Frame clones the
// position before storing it, so a single shared instance is safe).
const _drawPos = new THREE.Vector3();

// The drawing view renders at 4:3 to match the main p5 canvas (640x480),
// centered and letterboxed within the fullscreen container.
const DRAW_ASPECT = 640 / 480;

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
const PALETTE_HOLD_DURATION = 1600; // 1.6 seconds to reveal palette
const PALETTE_FLICKER_DURATION = 300; // 0.3 seconds
let palettes = [];
let paletteGripStartTime = []; // When grip started for each controller
let paletteVisible = []; // Whether palette is visible for each controller
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
let undoOverlay = null;
let undoCircleLeft = null;
let undoCircleRight = null;
const UNDO_CIRCLE_MAX_SIZE = 400; // pixels
const UNDO_CIRCLE_MIN_SCALE = 0.1; // 10%
const UNDO_CIRCLE_SPACING = 0.5; // 50% of circle width apart
let pendingAction = null; // 'undo' or 'reset'

// Confirm (green expanding) circle state
let confirmOverlay = null;
let confirmCircleLeft = null;
let confirmCircleRight = null;
let confirmHoldStart = null;
let confirmFlickerStart = null;
let confirmIsDouble = false; // single or double circle
let pendingConfirmAction = null; // 'single' or 'double'

// Orientation objects fade state
let orientationObjects = []; // Array of {mesh, material}
let orientationFadeStart = null;
const ORIENTATION_FADE_DURATION = 5000; // 5 seconds

async function setupMediaPipe() {
    const container = window._drawingContainer || document;

    // Wait for MediaPipe to be defined on the window
    while (!window.GestureRecognizer || !window.FilesetResolver) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const vision = await window.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );

    gestureRecognizer = await window.GestureRecognizer.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: MAX_HANDS
    });
    console.log("MediaPipe Loaded");
    const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';
}

function initThreeJS() {
    const container = window._drawingContainer || document.body;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    // Set up camera (position set by updateCameraFromSpherical)
    camera = new THREE.PerspectiveCamera(75, DRAW_ASPECT, 0.1, 1000);

    // Set up renderer
    const size = getDrawSize();
    renderer = new THREE.WebGLRenderer({ antialias: true });
    // Cap pixel ratio: on HiDPI displays the default (2+) doubles fill-rate
    // cost for little visible gain at this scene complexity.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(size.w, size.h);
    // Don't append here - startDrawingMode will handle it

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

    const cubeGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);

    // Center cube
    const matCenter = new THREE.MeshPhongMaterial({ color: 0x00ff00, transparent: true });
    const cubeCenter = new THREE.Mesh(cubeGeo, matCenter);
    worldNode.add(cubeCenter);

    // Right pyramid (pointing right)
    const pyramidGeo = new THREE.ConeGeometry(0.3, 0.5, 4);
    const matRight = new THREE.MeshPhongMaterial({ color: 0xff0000, transparent: true });
    const pyramidRight = new THREE.Mesh(pyramidGeo, matRight);
    pyramidRight.position.set(2, 0, 0);
    pyramidRight.rotation.z = -Math.PI / 2; // Rotate to point right
    worldNode.add(pyramidRight);

    // Top pyramid (pointing up)
    const matTop = new THREE.MeshPhongMaterial({ color: 0x0000ff, transparent: true });
    const pyramidTop = new THREE.Mesh(pyramidGeo, matTop);
    pyramidTop.position.set(0, 2, 0);
    worldNode.add(pyramidTop);

    // Store orientation objects for fade effect
    orientationObjects = [
        { mesh: cubeCenter, material: matCenter },
        { mesh: pyramidRight, material: matRight },
        { mesh: pyramidTop, material: matTop }
    ];
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
        controller.visible = false; // Hide by default
        controller.add(mesh); // Attach the visual indicator to the controller
        controller.add(rim); // Attach the color rim

        scene.add(controller);

        pointerMeshes.push(mesh);
        controllers.push(controller);

        // Create palette for this controller
        const palette = new Palette(0.6, 0.08);
        palette.visible = false;
        scene.add(palette);
        palettes.push(palette);
        paletteGripStartTime.push(null);
        paletteVisible.push(false);
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
        labelDiv.style.display = 'none';
        
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
    const size = getDrawSize();
    camera.aspect = DRAW_ASPECT;
    camera.updateProjectionMatrix();
    renderer.setSize(size.w, size.h);
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
    if (!keysPressed['w'] && !keysPressed['a'] && !keysPressed['s'] && !keysPressed['d']) {
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

    cameraTarget.add(movement);
    updateCameraFromSpherical();
}

async function setupWebcam() {
    const container = window._drawingContainer || document;
    video = container.querySelector('#webcam') || document.getElementById('webcam');
    video.style.display = 'none'; // Hide the actual video element

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        video.srcObject = stream;
        // Wait for video to be ready
        await new Promise(resolve => {
            video.addEventListener('loadeddata', resolve, { once: true });
        });
        // Hide loading message
        const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
        if (loadingEl) loadingEl.style.display = 'none';
    } catch (err) {
        console.error("Error accessing webcam:", err);
        const loadingEl = container.querySelector('#loading') || document.getElementById('loading');
        if (loadingEl) loadingEl.innerText = "Error accessing webcam.";
    }
}

// Track animation frame for cleanup
let animationFrameId = null;
let isRunning = false;

// Main animation loop
function animateLoop() {
    if (!isRunning) return;
    animationFrameId = requestAnimationFrame(animateLoop);

    // Update keyboard navigation (WASD)
    updateKeyboardNavigation();

    // Run MediaPipe Recognition
    if (gestureRecognizer && video.readyState >= 2) {
        let nowInMs = Date.now();
        if (video.currentTime !== lastVideoTime) {
            results = gestureRecognizer.recognizeForVideo(video, nowInMs);
            lastVideoTime = video.currentTime;
        }
    }

    // Hide all controllers and labels initially
    controllers.forEach(c => c.visible = false);
    labels.forEach(label => label.container.style.display = 'none');

    // Update controllers and labels based on results
    if (results && results.landmarks) {
        // Calculate the physical dimensions of the viewing plane at Z=0
        const depth = camera.position.z;
        const vFov = camera.fov * Math.PI / 180;
        const heightAtDepth = 2 * Math.tan(vFov / 2) * depth;
        const widthAtDepth = heightAtDepth * camera.aspect;

        for (let i = 0; i < results.landmarks.length && i < MAX_HANDS; i++) {
            const landmarks = results.landmarks[i];
            const worldLandmarks = results.worldLandmarks[i];
            const gestures = results.gestures[i];
            const handedness = results.handednesses[i];

            // landmark 8 is the index finger tip
            const pointer = landmarks[8];
            const worldPos = worldLandmarks[8];

            let handLabel = handedness[0].categoryName === "Left" ? "Right" : "Left"; // Mirrored for user
            let gestureName = gestures[0].categoryName; // e.g., "Open_Palm", "Closed_Fist"
            let isClosedFist = (gestureName === "Closed_Fist");
            let isOpenPalm = (gestureName === "Open_Palm");
            let isPointingUp = (gestureName === "Pointing_Up");
            let isThumbUp = (gestureName === "Thumb_Up");
            let isThumbDown = (gestureName === "Thumb_Down");
            let isVictory = (gestureName === "Victory");

            const controller = controllers[i];
            const mesh = pointerMeshes[i];
            const rim = controllerColorRims[i];
            controller.visible = true;

            // Make rim face the camera
            rim.lookAt(camera.position);

            // Update Color based on gesture
            if (isClosedFist) {
                mesh.material.color.setHex(0xff0000); // Red
            } else if (gestureName === "Open_Palm") {
                mesh.material.color.setHex(0x00ff00); // Green
            } else {
                mesh.material.color.setHex(0xffffff); // White
            }

            // Map MediaPipe normalized coordinates (0 to 1) to NDC (-1 to 1)
            // Mirror X axis
            const ndcX = 1 - 2 * pointer.x;
            const ndcY = 1 - 2 * pointer.y;

            // Scale NDC to world coordinates at Z=0 plane
            const worldX = (ndcX * widthAtDepth) / 2;
            const worldY = (ndcY * heightAtDepth) / 2;
            const worldZ = -pointer.z * 5;

            const newPos = new THREE.Vector3(worldX, worldY, worldZ);

            // Pass the new data into the controller wrapper
            controller.updatePose(newPos, null);
            controller.updateGrip(isClosedFist, isOpenPalm);
            controller.updateTrigger(isPointingUp, isOpenPalm, isClosedFist);
            controller.updateButtonA(isThumbUp);
            controller.updateButtonB(isThumbDown);
            controller.updateButtonC(isVictory);

            // Slightly scale mesh based on depth
            const scale = 1 - (pointer.z * 2);
            mesh.scale.setScalar(Math.max(0.1, scale));

            // Update HTML Labels
            const label = labels[i];
            label.container.style.display = 'block';
            label.main.innerText = `${handLabel}: ${gestureName}`;
            label.sub.innerText = `3D World: ${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)}, ${worldPos.z.toFixed(2)}`;

            // Position label on screen by converting 3D position back to 2D.
            // Map NDC onto the centered 4:3 canvas (offset by the letterbox bars).
            const screenPos = controller.position.clone();
            screenPos.project(camera);

            const drawSize = getDrawSize();
            const x = drawSize.offsetX + (screenPos.x * .5 + .5) * drawSize.w;
            const y = drawSize.offsetY + (screenPos.y * -.5 + .5) * drawSize.h;

            label.container.style.left = `${x}px`;
            label.container.style.top = `${y - 40}px`; // Offset above the sphere
        }
    }

    // For hands that are no longer detected, keep grip state unchanged (only open_palm releases)
    for (let i = results?.landmarks?.length || 0; i < MAX_HANDS; i++) {
        controllers[i].updatePose(null, null);
        controllers[i].updateGrip(false, false);
        controllers[i].updateTrigger(false, false, false);
        controllers[i].updateButtonA(false);
        controllers[i].updateButtonB(false);
        controllers[i].updateButtonC(false);
    }

    // Drawing logic - each controller can draw independently
    // Uses drawing position (50% smoothing - more responsive)
    for (let i = 0; i < MAX_HANDS; i++) {
        const controller = controllers[i];

        // Start new stroke on trigger_Down
        if (controller.trigger_Down) {
            const pos = _drawPos;
            controller.getDrawPosition(pos);
            frame.beginStroke(pos, i, controllerDrawColor[i]);
        }
        // Continue stroke while trigger_Held
        else if (controller.trigger_Held && frame.hasActiveStroke(i)) {
            const pos = _drawPos;
            controller.getDrawPosition(pos);
            frame.continueStroke(pos, i);
        }
        // End stroke on trigger_Up
        else if (controller.trigger_Up) {
            frame.endStroke(i);
        }
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

            // After 2 seconds, show palette
            if (gripElapsed >= PALETTE_HOLD_DURATION && !paletteVisible[i]) {
                // Only show palette if it's a single grip (not both controllers)
                const otherGrip = controllers[(i + 1) % MAX_HANDS].grip_Held;
                if (!otherGrip) {
                    paletteVisible[i] = true;
                    palette.visible = true;
                    paletteLine.visible = true;

                    // Spawn at controller's current position
                    const pos = _drawPos;
                    controller.getWorldPosition(pos);
                    paletteSpawnPos[i].copy(pos);
                    palette.position.copy(pos);

                    // Face the camera
                    palette.lookAt(camera.position);
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
            if (paletteVisible[i] && paletteFlickerStart[i] === null) {
                palette.visible = false;
                paletteLine.visible = false;
                paletteVisible[i] = false;
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
    const bothButtonC = controllers.every(c => c.buttonC_Held);
    if (bothButtonC) {
        // Reset all button states on both controllers
        for (const controller of controllers) {
            controller.grip_Down = false;
            controller.grip_Held = false;
            controller.trigger_Down = false;
            controller.trigger_Held = false;
            controller.trigger_Up = false;
            controller.buttonA_Down = false;
            controller.buttonA_Held = false;
            controller.buttonB_Down = false;
            controller.buttonB_Held = false;
            controller.buttonC_Down = false;
            controller.buttonC_Held = false;
        }
        // Reset camera
        resetCamera();
        // Reset world origin
        worldNode.position.set(0, 0, 0);
        worldNode.quaternion.identity();
        worldNode.scale.set(1, 1, 1);
        // Reset undo/reset timer state
        undoHoldStart = null;
        undoFlickerStart = null;
        pendingAction = null;
        undoOverlay.style.display = 'none';
        undoCircleLeft.style.display = 'none';
        undoCircleRight.style.display = 'none';
        // Reset orientation objects fade
        orientationFadeStart = now;
        for (const obj of orientationObjects) {
            obj.material.opacity = 1;
        }
    }

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
            undoCircleLeft.style.display = 'block';
            undoCircleRight.style.display = 'block';
        } else {
            // Single centered circle (use left circle only)
            undoCircleLeft.style.transform = baseTransform;
            undoCircleLeft.style.display = 'block';
            undoCircleRight.style.display = 'none';
        }
    };

    // Handle flicker phase
    if (undoFlickerStart !== null) {
        const flickerElapsed = now - undoFlickerStart;
        if (flickerElapsed < UNDO_FLICKER_DURATION) {
            // Flicker on/off every 50ms
            const flickerOn = Math.floor(flickerElapsed / 50) % 2 === 0;
            undoOverlay.style.display = flickerOn ? 'block' : 'none';
            if (flickerOn) {
                updateCirclePositions(UNDO_CIRCLE_MIN_SCALE, pendingAction === 'reset');
            }
        } else {
            // Flicker done - action already performed by Frame flicker methods
            const wasReset = pendingAction === 'reset';
            undoOverlay.style.display = 'none';
            undoCircleLeft.style.display = 'none';
            undoCircleRight.style.display = 'none';
            undoFlickerStart = null;
            undoHoldStart = null;
            pendingAction = null;
            // Reset all button states on both controllers
            for (const controller of controllers) {
                controller.grip_Down = false;
                controller.grip_Held = false;
                controller.trigger_Down = false;
                controller.trigger_Held = false;
                controller.trigger_Up = false;
                controller.buttonA_Down = false;
                controller.buttonA_Held = false;
                controller.buttonB_Down = false;
                controller.buttonB_Held = false;
                controller.buttonC_Down = false;
                controller.buttonC_Held = false;
            }
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

        if (undoHoldStart === null) {
            undoHoldStart = now;
            pendingAction = currentAction;
        } else if (currentAction === 'reset') {
            // Upgrade to reset if both are now held
            pendingAction = 'reset';
        }

        const holdElapsed = now - undoHoldStart;
        const progress = Math.min(holdElapsed / UNDO_HOLD_DURATION, 1);

        // Show and shrink circle(s)
        undoOverlay.style.display = 'block';
        const scale = 1 - progress * (1 - UNDO_CIRCLE_MIN_SCALE);
        updateCirclePositions(scale, pendingAction === 'reset');

        // Timer complete - start flicker for both circle and strokes
        if (progress >= 1) {
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
            pendingAction = null;
            undoOverlay.style.display = 'none';
            undoCircleLeft.style.display = 'none';
            undoCircleRight.style.display = 'none';
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
                confirmCircleLeft.style.display = 'block';
            }
            if (confirmCircleRight) {
                confirmCircleRight.style.transform = `translate(calc(-50% + ${offset}px), -50%) scale(${scale})`;
                confirmCircleRight.style.display = 'block';
            }
        } else {
            // Single centered circle
            if (confirmCircleLeft) {
                confirmCircleLeft.style.transform = baseTransform;
                confirmCircleLeft.style.display = 'block';
            }
            if (confirmCircleRight) {
                confirmCircleRight.style.display = 'none';
            }
        }
    };

    // Handle confirm flicker phase
    if (confirmFlickerStart !== null) {
        const flickerElapsed = now - confirmFlickerStart;
        if (flickerElapsed < UNDO_FLICKER_DURATION) {
            // Flicker on/off every 50ms
            const flickerOn = Math.floor(flickerElapsed / 50) % 2 === 0;
            if (confirmOverlay) confirmOverlay.style.display = flickerOn ? 'block' : 'none';
            if (flickerOn) {
                updateConfirmCirclePositions(1, pendingConfirmAction === 'double');
            }
        } else {
            // Flicker done
            const wasSingle = pendingConfirmAction === 'single';
            if (confirmOverlay) confirmOverlay.style.display = 'none';
            if (confirmCircleLeft) confirmCircleLeft.style.display = 'none';
            if (confirmCircleRight) confirmCircleRight.style.display = 'none';
            confirmFlickerStart = null;
            confirmHoldStart = null;
            pendingConfirmAction = null;
            // Reset button states
            for (const controller of controllers) {
                controller.buttonA_Down = false;
                controller.buttonA_Held = false;
            }
            // Single Button A = camera reset + world reset + show orientation objects
            if (wasSingle) {
                // Reset camera
                resetCamera();
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
                // Double Button A = exit drawing mode
                stopDrawingMode();
                const container = window._drawingContainer;
                if (container) container.classList.remove('active');
            }
        }
    }
    // Handle confirm hold countdown phase (expanding circles)
    else if (bothButtonAHeld || singleButtonAHeld) {
        const currentAction = bothButtonAHeld ? 'double' : 'single';

        if (confirmHoldStart === null) {
            confirmHoldStart = now;
            pendingConfirmAction = currentAction;
        } else if (currentAction === 'double') {
            // Upgrade to double if both are now held
            pendingConfirmAction = 'double';
        }

        const holdElapsed = now - confirmHoldStart;
        const progress = Math.min(holdElapsed / UNDO_HOLD_DURATION, 1);

        // Show and expand circle(s) (reverse of shrink)
        if (confirmOverlay) confirmOverlay.style.display = 'block';
        const scale = UNDO_CIRCLE_MIN_SCALE + progress * (1 - UNDO_CIRCLE_MIN_SCALE);
        updateConfirmCirclePositions(scale, pendingConfirmAction === 'double');

        // Timer complete - start flicker
        if (progress >= 1) {
            confirmFlickerStart = now;
        }
    } else {
        // Button released - cancel action
        if (confirmFlickerStart === null) {
            confirmHoldStart = null;
            pendingConfirmAction = null;
            if (confirmOverlay) confirmOverlay.style.display = 'none';
            if (confirmCircleLeft) confirmCircleLeft.style.display = 'none';
            if (confirmCircleRight) confirmCircleRight.style.display = 'none';
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

    renderer.render(scene, camera);
}

// Export functions for external control
export async function startDrawingMode(container) {
    if (isRunning) return;
    isRunning = true;

    // Store reference to container for cleanup
    window._drawingContainer = container;

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
    const size = getDrawSize();
    renderer.setSize(size.w, size.h);
    if (camera) {
        camera.aspect = DRAW_ASPECT;
        camera.updateProjectionMatrix();
    }

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

    await setupMediaPipe();
    await setupWebcam();

    // Enable mouse controller
    if (mouseController) {
        mouseController.enable();
    }

    // Start animation loop
    animateLoop();
}

export function stopDrawingMode() {
    isRunning = false;

    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    // Convert drawing to NAPLPS before stopping
    convertToNAPLPS();

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
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    // Hide labels
    labels.forEach(label => {
        if (label.container) label.container.style.display = 'none';
    });
}

function convertToNAPLPS() {
    if (!frame || !frame.strokes || frame.strokes.length === 0) {
        console.log('No strokes to convert');
        return;
    }

    // NapInputWrapper, NapEncoder, Vector2, Vector3 are global (from naplps.js)
    if (typeof window.NapInputWrapper === 'undefined' || typeof window.NapEncoder === 'undefined') {
        console.error('NapInputWrapper or NapEncoder not available');
        return;
    }

    const input = [];

    for (const stroke of frame.strokes) {
        if (!stroke.points || stroke.points.length < 2) continue;

        // Get brush outline (closed polygon) instead of centerline
        const outline3D = stroke.toBrushOutline();
        if (outline3D.length < 3) continue;

        // Convert hex color to RGB Vector3 (0-255)
        const hex = stroke.color || 0xffffff;
        const r = (hex >> 16) & 0xff;
        const g = (hex >> 8) & 0xff;
        const b = hex & 0xff;
        const color = new window.Vector3(r, g, b);

        // Project 3D outline points to 2D normalized coordinates
        let points2D = [];
        for (const pt of outline3D) {
            // Clone point and project to NDC (-1 to 1)
            const projected = pt.clone().project(camera);

            // Convert NDC to normalized 0-1 coordinates
            // NDC: x=-1 is left, x=1 is right; y=-1 is bottom, y=1 is top
            // NAPLPS: x=0 is left, x=1 is right; y=0 is top, y=1 is bottom
            const nx = (projected.x + 1) / 2;

            // The main canvas renders NAPLPS into a SQUARE 640x640 space, so the
            // 4:3 view's vertical extent must be compressed by 480/640 (= 1/DRAW_ASPECT)
            // and pushed down by the remainder, matching the SVG-import convention
            // (y/sH*0.75 + 0.25). Without this the drawing looks horizontally squeezed.
            const vScale = 1 / DRAW_ASPECT; // 0.75
            let ny = ((1 - projected.y) / 2) * vScale + (1 - vScale); // Flip Y, fit 4:3

            // Clamp to valid range
            const clampedX = Math.max(0, Math.min(1, nx));
            const clampedY = Math.max(0, Math.min(1, ny));

            points2D.push(new window.Vector2(clampedX, clampedY));
        }

        // Simplify points using RDP algorithm
        if (window.rdpSimplify) {
            points2D = window.rdpSimplify(points2D, 0.002);
        }

        // Create NapInputWrapper as filled polygon
        const napStroke = new window.NapInputWrapper(color, points2D, true);
        input.push(napStroke);
    }

    if (input.length === 0) {
        console.log('No valid strokes to encode');
        return;
    }

    // Encode to NAPLPS
    const encoder = new window.NapEncoder(input);

    // Load into the main canvas
    if (typeof window.loadTelidonFromText === 'function') {
        window.loadTelidonFromText(encoder.napRaw);
    } else {
        console.error('loadTelidonFromText not available');
    }

    console.log(`Converted ${input.length} strokes to NAPLPS`);
}

