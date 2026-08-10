import * as THREE from 'three';

/**
 * MouseController - Projects mouse into 3D space for drawing
 * Left click to draw, right click to toggle palette
 */
export class MouseController extends THREE.Object3D {
    constructor() {
        super();

        // Mouse state
        this.mouseX = 0;
        this.mouseY = 0;
        this.isLeftDown = false;
        this.isRightDown = false;

        // Drawing state (mirrors Controller)
        this.trigger_Down = false;
        this.trigger_Held = false;
        this.trigger_Up = false;

        // Palette state
        this.paletteActive = false;
        this.paletteJustOpened = false;

        // Drawing color
        this.drawColor = 0xffffff;

        // Smoothed position for drawing
        this._smoothPosition = new THREE.Vector3();
        this._drawPosition = new THREE.Vector3();
        this._initialized = false;

        // Raycaster for projecting mouse into scene
        this._raycaster = new THREE.Raycaster();
        this._mouseNDC = new THREE.Vector2();

        // Drawing plane - fixed distance from camera
        this._drawPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        this._drawDistance = 5; // Fixed distance from camera

        // Visibility timeout
        this._hideTimeout = null;
        this._hideDelay = 5000; // 5 seconds
        this._cursorHidden = true; // Start hidden

        // Visual indicator (50% smaller)
        const geometry = new THREE.SphereGeometry(0.075, 16, 16);
        const material = new THREE.MeshBasicMaterial({ color: 0xffff00 });
        this._cursor = new THREE.Mesh(geometry, material);
        this._cursor.visible = false; // Start hidden
        this.add(this._cursor);

        // Color rim around cursor (50% smaller)
        const rimGeo = new THREE.RingGeometry(0.085, 0.11, 32);
        const rimMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            depthTest: false
        });
        this._colorRim = new THREE.Mesh(rimGeo, rimMat);
        this._colorRim.renderOrder = 998;
        this._colorRim.visible = false; // Start hidden
        this.add(this._colorRim);

        // Bind event handlers
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onContextMenu = this._onContextMenu.bind(this);
    }

    /**
     * Start listening for mouse events
     */
    enable() {
        // Start with cursor hidden
        this.hide();
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('contextmenu', this._onContextMenu);
    }

    /**
     * Stop listening for mouse events
     */
    disable() {
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mouseup', this._onMouseUp);
        window.removeEventListener('contextmenu', this._onContextMenu);
        this._clearHideTimeout();
        this.hide();
    }

    _onMouseMove(event) {
        this.mouseX = event.clientX;
        this.mouseY = event.clientY;

        // Convert to NDC (-1 to 1)
        this._mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
        this._mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;

        // Show cursor on mouse move
        this.show();

        // Reset hide timeout
        this._resetHideTimeout();
    }

    _onMouseDown(event) {
        // Ignore when Alt is held (camera navigation)
        if (event.altKey) return;

        if (event.button === 0) {
            // Left click
            if (!this.paletteActive) {
                this.isLeftDown = true;
            } else {
                // Left click while palette active - for color selection
                this.isLeftDown = true;
            }
        } else if (event.button === 2) {
            // Right click
            this.isRightDown = true;
        }
    }

    _onMouseUp(event) {
        if (event.button === 0) {
            this.isLeftDown = false;
        } else if (event.button === 2) {
            this.isRightDown = false;
        }
    }

    _onContextMenu(event) {
        event.preventDefault();
    }

    /**
     * Update controller state - call each frame
     * @param {THREE.Camera} camera - The scene camera
     */
    update(camera) {
        // Update draw plane to be at fixed distance from camera, facing camera
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const planeCenter = camera.position.clone().addScaledVector(forward, this._drawDistance);
        this._drawPlane.setFromNormalAndCoplanarPoint(forward.clone().negate(), planeCenter);

        // Project mouse ray onto draw plane
        this._raycaster.setFromCamera(this._mouseNDC, camera);

        const intersection = new THREE.Vector3();
        if (this._raycaster.ray.intersectPlane(this._drawPlane, intersection)) {
            this.position.copy(intersection);
        }

        // Make rim face camera
        this._colorRim.lookAt(camera.position);

        // Smooth position for drawing (50% smoothing like Controller)
        if (!this._initialized) {
            this._smoothPosition.copy(this.position);
            this._drawPosition.copy(this.position);
            this._initialized = true;
        } else {
            this._smoothPosition.lerp(this.position, 0.5);
            this._drawPosition.copy(this._smoothPosition);
        }

        // Update trigger states based on left mouse (only when palette not active)
        const wasHeld = this.trigger_Held;

        if (!this.paletteActive && this.isLeftDown) {
            if (!wasHeld) {
                this.trigger_Down = true;
                this.trigger_Held = true;
            } else {
                this.trigger_Down = false;
            }
            this.trigger_Up = false;
        } else {
            this.trigger_Down = false;
            if (wasHeld) {
                this.trigger_Up = true;
            } else {
                this.trigger_Up = false;
            }
            this.trigger_Held = false;
        }
    }

    /**
     * Check if right click just happened (for palette toggle)
     * @returns {boolean}
     */
    checkRightClick() {
        if (this.isRightDown) {
            this.isRightDown = false; // Consume the click
            return true;
        }
        return false;
    }

    /**
     * Check if left click just happened (for palette color selection)
     * @returns {boolean}
     */
    checkLeftClick() {
        if (this.isLeftDown && !this.trigger_Held) {
            return true;
        }
        return false;
    }

    /**
     * Get the smoothed drawing position
     * @param {THREE.Vector3} target - Vector to store result
     */
    getDrawPosition(target) {
        target.copy(this._drawPosition);
    }

    /**
     * Set the draw plane distance from camera
     * @param {number} distance - Distance along camera's forward direction
     */
    setDrawPlaneDistance(distance) {
        this._drawDistance = distance;
    }

    /**
     * Set the drawing color
     * @param {number} color - Hex color value
     */
    setColor(color) {
        this.drawColor = color;
        this._colorRim.material.color.setHex(color);
    }

    /**
     * Set cursor visibility
     * @param {boolean} visible
     */
    setCursorVisible(visible) {
        this._cursor.visible = visible;
        this._colorRim.visible = visible;
    }

    /**
     * Show the cursor and start hide timeout
     */
    show() {
        if (this._cursorHidden) {
            this._cursor.visible = true;
            this._colorRim.visible = true;
            this._cursorHidden = false;
        }
    }

    /**
     * Hide the cursor
     */
    hide() {
        this._cursor.visible = false;
        this._colorRim.visible = false;
        this._cursorHidden = true;
        this._clearHideTimeout();
    }

    /**
     * Reset the auto-hide timeout
     * @private
     */
    _resetHideTimeout() {
        this._clearHideTimeout();
        this._hideTimeout = setTimeout(() => {
            this.hide();
        }, this._hideDelay);
    }

    /**
     * Clear the hide timeout
     * @private
     */
    _clearHideTimeout() {
        if (this._hideTimeout) {
            clearTimeout(this._hideTimeout);
            this._hideTimeout = null;
        }
    }
}
