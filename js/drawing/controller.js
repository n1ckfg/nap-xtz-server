import * as THREE from 'three';

/**
 * Simple 1D Kalman filter for smoothing noisy measurements
 */
class KalmanFilter1D {
    /**
     * @param {number} Q - Process noise (lower = smoother, slower response)
     * @param {number} R - Measurement noise (higher = smoother, trusts measurements less)
     */
    constructor(Q = 0.1, R = 0.5) {
        this.Q = Q; // Process noise
        this.R = R; // Measurement noise
        this.x = 0; // Estimated value
        this.P = 1; // Estimation error covariance
        this.initialized = false;
    }

    /**
     * Update filter with new measurement
     * @param {number} measurement - The raw measurement
     * @returns {number} - The filtered value
     */
    update(measurement) {
        if (!this.initialized) {
            this.x = measurement;
            this.initialized = true;
            return this.x;
        }

        // Prediction
        this.P = this.P + this.Q;

        // Update
        const K = this.P / (this.P + this.R); // Kalman gain
        this.x = this.x + K * (measurement - this.x);
        this.P = (1 - K) * this.P;

        return this.x;
    }

    reset() {
        this.x = 0;
        this.P = 1;
        this.initialized = false;
    }
}

export class Controller extends THREE.Object3D {
    /**
     * @param {Object} [kalmanConfig] - Kalman filter configuration
     * @param {number} [kalmanConfig.Q=0.1] - Process noise (lower = smoother)
     * @param {number} [kalmanConfig.R=0.5] - Measurement noise (higher = smoother)
     * @param {boolean} [kalmanConfig.enabled=true] - Whether filtering is enabled
     */
    constructor(kalmanConfig = {}) {
        super();
        // Grip button (Closed_Fist to engage, Open_Palm to release)
        this.grip_Down = false;
        this.grip_Held = false;
        this._wasGrip_Held = false;

        // Trigger button
        this.trigger_Down = false;
        this.trigger_Held = false;
        this._wasTrigger_Held = false;

        // Button A
        this.buttonA_Down = false;
        this.buttonA_Held = false;
        this._wasButtonA_Held = false;

        // Button B
        this.buttonB_Down = false;
        this.buttonB_Held = false;
        this._wasButtonB_Held = false;

        // Button C
        this.buttonC_Down = false;
        this.buttonC_Held = false;
        this._wasButtonC_Held = false;

        // Grip timeout - release grip if closed_fist not seen for this duration
        this.gripTimeout = 1000; // ms
        this._lastClosedFistTime = 0;

        // Kalman filter setup - separate filters for drawing and navigation
        // Base smoothing: Q=0.1, R=0.5
        // Drawing: 50% smoothing (less smooth, more responsive)
        // Navigation: 200% smoothing (more smooth, less responsive)
        const baseQ = kalmanConfig.Q ?? 0.1;
        const baseR = kalmanConfig.R ?? 0.5;
        this.kalmanEnabled = kalmanConfig.enabled ?? true;

        // Drawing filters (50% = half the smoothing, double Q, halve R)
        const drawQ = baseQ * 2;
        const drawR = baseR * 0.5;
        this._drawKalmanX = new KalmanFilter1D(drawQ, drawR);
        this._drawKalmanY = new KalmanFilter1D(drawQ, drawR);
        this._drawKalmanZ = new KalmanFilter1D(drawQ, drawR);
        this._drawPosition = new THREE.Vector3();

        // Navigation filters (200% = double the smoothing, halve Q, double R)
        const navQ = baseQ * 0.5;
        const navR = baseR * 2;
        this._navKalmanX = new KalmanFilter1D(navQ, navR);
        this._navKalmanY = new KalmanFilter1D(navQ, navR);
        this._navKalmanZ = new KalmanFilter1D(navQ, navR);
        this._navPosition = new THREE.Vector3();

        // Confidence scoring
        this.confidence = 1.0;
        this._prevPosition = new THREE.Vector3();
        this._prevVelocity = new THREE.Vector3();
        this._hasHistory = false;
        this._confidenceSmoothing = 0.1; // EMA factor (lower = smoother)
        this._buttonsBlocked = false;
        this._blockThreshold = 0.2;
        this._unblockThreshold = 0.4;
        // Tuning: acceleration magnitude that maps to confidence ~0.5
        this._accelMidpoint = 0.15;
    }

    /**
     * Updates the rolling confidence score based on motion smoothness.
     * Uses acceleration magnitude as a measure of jerkiness.
     * @private
     * @param {THREE.Vector3} currentPosition
     */
    _updateConfidence(currentPosition) {
        if (!this._hasHistory) {
            this._prevPosition.copy(currentPosition);
            this._prevVelocity.set(0, 0, 0);
            this._hasHistory = true;
            return;
        }

        // Calculate current velocity
        const velocity = new THREE.Vector3().subVectors(currentPosition, this._prevPosition);

        // Calculate acceleration (change in velocity)
        const acceleration = new THREE.Vector3().subVectors(velocity, this._prevVelocity);
        const accelMag = acceleration.length();

        // Map acceleration to instantaneous confidence
        // accelMag = 0 -> confidence = 1.0
        // accelMag = _accelMidpoint -> confidence ~= 0.5
        // accelMag = high -> confidence -> 0
        const instantConfidence = Math.exp(-accelMag / this._accelMidpoint * 0.693); // 0.693 = ln(2)

        // Exponential moving average for smooth rolling score
        this.confidence = this.confidence * (1 - this._confidenceSmoothing)
                        + instantConfidence * this._confidenceSmoothing;
        this.confidence = Math.max(0, Math.min(1, this.confidence));

        // Hysteresis for button blocking
        if (this._buttonsBlocked) {
            if (this.confidence > this._unblockThreshold) {
                this._buttonsBlocked = false;
            }
        } else {
            if (this.confidence < this._blockThreshold) {
                this._buttonsBlocked = true;
            }
        }

        // Store for next frame
        this._prevPosition.copy(currentPosition);
        this._prevVelocity.copy(velocity);
    }

    /**
     * Gets the drawing position (50% smoothing - more responsive)
     * @param {THREE.Vector3} target - Vector to store the result
     * @returns {THREE.Vector3} The drawing position in world space
     */
    getDrawPosition(target) {
        if (!target) target = new THREE.Vector3();
        // Transform local draw position to world space
        target.copy(this._drawPosition);
        if (this.parent) {
            this.parent.localToWorld(target);
        }
        return target;
    }

    /**
     * Gets the navigation position (200% smoothing - smoother)
     * @param {THREE.Vector3} target - Vector to store the result
     * @returns {THREE.Vector3} The navigation position in world space
     */
    getNavPosition(target) {
        if (!target) target = new THREE.Vector3();
        target.copy(this._navPosition);
        if (this.parent) {
            this.parent.localToWorld(target);
        }
        return target;
    }

    /**
     * Updates only the controller's pose (position and rotation).
     * @param {THREE.Vector3} position - The new position of the controller
     * @param {THREE.Quaternion} [rotation] - The new rotation of the controller (optional)
     */
    updatePose(position, rotation) {
        if (position) {
            if (this.kalmanEnabled) {
                // Update drawing position (50% smoothing - more responsive)
                this._drawPosition.set(
                    this._drawKalmanX.update(position.x),
                    this._drawKalmanY.update(position.y),
                    this._drawKalmanZ.update(position.z)
                );

                // Update navigation position (200% smoothing - smoother)
                this._navPosition.set(
                    this._navKalmanX.update(position.x),
                    this._navKalmanY.update(position.y),
                    this._navKalmanZ.update(position.z)
                );

                // Use navigation position for the controller's base position
                this.position.copy(this._navPosition);
            } else {
                this.position.copy(position);
                this._drawPosition.copy(position);
                this._navPosition.copy(position);
            }

            // Calculate confidence based on motion smoothness
            this._updateConfidence(this.position);
        }

        if (rotation) {
            this.quaternion.copy(rotation);
        }
    }

    /**
     * Updates only the grip state based on gestures.
     * @param {boolean} isClosedFist - True if the closed fist gesture is detected
     * @param {boolean} isOpenPalm - True if the open palm gesture is detected
     */
    updateGrip(isClosedFist, isOpenPalm) {
        const now = performance.now();

        // Track when we last saw closed fist
        if (isClosedFist) {
            this._lastClosedFistTime = now;
        }

        // Only turn on grip with closed fist, only turn off with open palm or timeout
        // Ignore button activation if confidence is too low
        if (this._buttonsBlocked) {
            // When blocked, treat as if no gesture detected (but don't force release)
            if (this.grip_Held && (now - this._lastClosedFistTime > this.gripTimeout)) {
                this.grip_Held = false;
            }
        } else if (isClosedFist) {
            this.grip_Held = true;
        } else if (isOpenPalm) {
            // Open palm releases all buttons
            this.grip_Held = false;
            this.trigger_Held = false;
            this.buttonA_Held = false;
            this.buttonB_Held = false;
        } else if (this.grip_Held && (now - this._lastClosedFistTime > this.gripTimeout)) {
            // Timeout: no closed_fist detected for gripTimeout ms while grip_Held
            this.grip_Held = false;
        }
        // Otherwise, grip_Held remains unchanged

        this.grip_Down = this.grip_Held && !this._wasGrip_Held;
        this._wasGrip_Held = this.grip_Held;
    }

    /**
     * Updates the trigger button state.
     * Trigger is sticky: only turns on with isHeld, turns off with isOpenPalm or isClosedFist.
     * @param {boolean} isHeld - True if the trigger gesture is detected
     * @param {boolean} isOpenPalm - True if open palm gesture is detected
     * @param {boolean} isClosedFist - True if closed fist gesture is detected
     */
    updateTrigger(isHeld, isOpenPalm, isClosedFist) {
        // Ignore activation when buttons are blocked due to low confidence
        if (!this._buttonsBlocked && isHeld) {
            this.trigger_Held = true;
        } else if (isOpenPalm || isClosedFist) {
            this.trigger_Held = false;
        }
        // Otherwise trigger_Held remains unchanged

        this.trigger_Down = this.trigger_Held && !this._wasTrigger_Held;
        this.trigger_Up = !this.trigger_Held && this._wasTrigger_Held;
        this._wasTrigger_Held = this.trigger_Held;
    }

    /**
     * Updates the button A state.
     * @param {boolean} isHeld - True if the button A gesture is detected
     */
    updateButtonA(isHeld) {
        // Ignore activation when buttons are blocked due to low confidence
        if (!this._buttonsBlocked) {
            this.buttonA_Held = isHeld;
        } else {
            this.buttonA_Held = false;
        }
        this.buttonA_Down = this.buttonA_Held && !this._wasButtonA_Held;
        this._wasButtonA_Held = this.buttonA_Held;
    }

    /**
     * Updates the button B state.
     * @param {boolean} isHeld - True if the button B gesture is detected
     */
    updateButtonB(isHeld) {
        // Ignore activation when buttons are blocked due to low confidence
        if (!this._buttonsBlocked) {
            this.buttonB_Held = isHeld;
        } else {
            this.buttonB_Held = false;
        }
        this.buttonB_Down = this.buttonB_Held && !this._wasButtonB_Held;
        this._wasButtonB_Held = this.buttonB_Held;
    }

    /**
     * Updates the button C state.
     * @param {boolean} isHeld - True if the button C gesture is detected
     */
    updateButtonC(isHeld) {
        // Ignore activation when buttons are blocked due to low confidence
        if (!this._buttonsBlocked) {
            this.buttonC_Held = isHeld;
        } else {
            this.buttonC_Held = false;
        }
        this.buttonC_Down = this.buttonC_Held && !this._wasButtonC_Held;
        this._wasButtonC_Held = this.buttonC_Held;
    }
}
