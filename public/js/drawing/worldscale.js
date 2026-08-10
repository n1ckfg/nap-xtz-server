import * as THREE from 'three';

const SevenMode = {
    BOTH: 0,
    MAIN: 1,
    ALT: 2,
    NONE: 3
};

export class OpenXR_WorldScale {
    /**
     * @param {THREE.Object3D} cltMain - The main controller (must have 'grip_Held' and 'grip_Down' boolean properties updated externally)
     * @param {THREE.Object3D} cltAlt - The alt controller (must have 'grip_Held' and 'grip_Down' boolean properties updated externally)
     * @param {THREE.Object3D} target - The target object to be manipulated
     */
    constructor(cltMain, cltAlt, target) {
        this.cltMain = cltMain;
        this.cltAlt = cltAlt;
        this.target = target;

        this.armed = false;
        this.sevenMode = SevenMode.NONE;
        this._wasGrip_Held = false;

        this.initialHandPosition1 = new THREE.Vector3();
        this.initialHandPosition2 = new THREE.Vector3();
        this.initialObjectRotation = new THREE.Quaternion();
        this.initialObjectScale = new THREE.Vector3();
        this.initialObjectDirection = new THREE.Vector3();

        this.origParent = target.parent;

        // Ring buffer for 3-second position history
        this.bufferDuration = 300; // 3 seconds in ms
        this.positionBuffer = []; // Array of {time, position, rotation, scale}

        // Lerp state
        this.isLerping = false;
        this.lerpStartTime = 0;
        this.lerpDuration = 300; // 300ms lerp
        this.lerpStartPos = new THREE.Vector3();
        this.lerpStartRot = new THREE.Quaternion();
        this.lerpStartScale = new THREE.Vector3();
        this.lerpTargetPos = new THREE.Vector3();
        this.lerpTargetRot = new THREE.Quaternion();
        this.lerpTargetScale = new THREE.Vector3();
    }

    /**
     * Must be called every frame in the render loop.
     */
    update() {
        const isGrip_Held = this.cltMain.grip_Held || this.cltAlt.grip_Held;
        const now = performance.now();

        // Detect grip start
        if (isGrip_Held && !this._wasGrip_Held) {
            this.positionBuffer = [];
            this.isLerping = false;
        }

        // Detect grip end - start lerp to buffered position
        if (!isGrip_Held && this._wasGrip_Held) {
            this._startRewindLerp(now);
        }

        this._wasGrip_Held = isGrip_Held;

        // Handle lerp animation when not gripping
        if (this.isLerping) {
            this._updateLerp(now);
            return;
        }

        if (this.cltMain.grip_Down || this.cltAlt.grip_Down) {
            if (this.origParent) {
                this.origParent.attach(this.target);
            }
            this.armed = true;
        }

        if (this.cltMain.grip_Held && this.cltAlt.grip_Held) {
            this.sevenMode = SevenMode.BOTH;
        } else if (this.cltMain.grip_Held && !this.cltAlt.grip_Held) {
            this.sevenMode = SevenMode.NONE; //MAIN;
        } else if (!this.cltMain.grip_Held && this.cltAlt.grip_Held) {
            this.sevenMode = SevenMode.NONE; //ALT;
        } else if (!this.cltMain.grip_Held && !this.cltAlt.grip_Held) {
            this.sevenMode = SevenMode.NONE;
            if (this.origParent) {
                this.origParent.attach(this.target);
            }
            this.armed = false;
            return;
        }

        if (this.armed) {
            switch (this.sevenMode) {
                case SevenMode.BOTH:
                    this.attachTargetBoth();
                    break;
                case SevenMode.MAIN:
                    this.attachTargetOne(this.cltMain);
                    break;
                case SevenMode.ALT:
                    this.attachTargetOne(this.cltAlt);
                    break;
            }
            this.armed = false;
        }

        switch (this.sevenMode) {
            case SevenMode.BOTH:
                this.updateTargetBoth();
                break;
        }

        // Record position to ring buffer while gripping
        if (isGrip_Held) {
            this._recordPosition(now);
        }
    }

    /**
     * Records current target transform to the ring buffer
     * @private
     */
    _recordPosition(now) {
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();
        const scale = new THREE.Vector3();

        this.target.getWorldPosition(pos);
        this.target.getWorldQuaternion(rot);
        this.target.getWorldScale(scale);

        this.positionBuffer.push({ time: now, position: pos, rotation: rot, scale: scale });

        // Remove entries older than bufferDuration
        const cutoff = now - this.bufferDuration;
        while (this.positionBuffer.length > 0 && this.positionBuffer[0].time < cutoff) {
            this.positionBuffer.shift();
        }
    }

    /**
     * Starts the rewind lerp to the oldest buffered position
     * @private
     */
    _startRewindLerp(now) {
        if (this.positionBuffer.length === 0) return;

        // Get the oldest position in buffer (beginning of 3-second window)
        const targetState = this.positionBuffer[0];

        // Get current transform
        this.target.getWorldPosition(this.lerpStartPos);
        this.target.getWorldQuaternion(this.lerpStartRot);
        this.target.getWorldScale(this.lerpStartScale);

        this.lerpTargetPos.copy(targetState.position);
        this.lerpTargetRot.copy(targetState.rotation);
        this.lerpTargetScale.copy(targetState.scale);

        this.lerpStartTime = now;
        this.isLerping = true;

        // Re-attach to original parent for the lerp
        if (this.origParent) {
            this.origParent.attach(this.target);
        }
    }

    /**
     * Updates the lerp animation
     * @private
     */
    _updateLerp(now) {
        const elapsed = now - this.lerpStartTime;
        let t = Math.min(elapsed / this.lerpDuration, 1);

        // Ease out cubic
        t = 1 - Math.pow(1 - t, 3);

        const newPos = new THREE.Vector3().lerpVectors(this.lerpStartPos, this.lerpTargetPos, t);
        const newRot = new THREE.Quaternion().slerpQuaternions(this.lerpStartRot, this.lerpTargetRot, t);
        const newScale = new THREE.Vector3().lerpVectors(this.lerpStartScale, this.lerpTargetScale, t);

        this._setWorldTransform(this.target, newPos, newRot, newScale);

        if (t >= 1) {
            this.isLerping = false;
            this.positionBuffer = [];
        }
    }

    attachTargetBoth() {
        this.cltMain.getNavPosition(this.initialHandPosition1);
        this.cltAlt.getNavPosition(this.initialHandPosition2);
        
        this.target.getWorldQuaternion(this.initialObjectRotation);
        this.target.getWorldScale(this.initialObjectScale);
        
        const targetPos = new THREE.Vector3();
        this.target.getWorldPosition(targetPos);
        
        const midpoint = new THREE.Vector3()
            .addVectors(this.initialHandPosition1, this.initialHandPosition2)
            .multiplyScalar(0.5);
            
        this.initialObjectDirection.subVectors(targetPos, midpoint);
    }

    updateTargetBoth() {
        const currentHandPosition1 = new THREE.Vector3();
        this.cltMain.getNavPosition(currentHandPosition1);

        const currentHandPosition2 = new THREE.Vector3();
        this.cltAlt.getNavPosition(currentHandPosition2);

        const handDir1 = new THREE.Vector3()
            .subVectors(this.initialHandPosition1, this.initialHandPosition2)
            .normalize();
            
        const handDir2 = new THREE.Vector3()
            .subVectors(currentHandPosition1, currentHandPosition2)
            .normalize();

        const handRot = new THREE.Quaternion().setFromUnitVectors(handDir1, handDir2);

        const currentGrabDistance = currentHandPosition1.distanceTo(currentHandPosition2);
        const initialGrabDistance = this.initialHandPosition1.distanceTo(this.initialHandPosition2);
        
        const p = initialGrabDistance > 0 ? (currentGrabDistance / initialGrabDistance) : 1;

        const newScale = new THREE.Vector3()
            .copy(this.initialObjectScale)
            .multiplyScalar(p);

        // Apply initialObjectRotation then handRot (equivalent to handRot * initialObjectRotation in Unity)
        const newRotation = new THREE.Quaternion()
            .copy(handRot)
            .multiply(this.initialObjectRotation);

        const midpoint = new THREE.Vector3()
            .addVectors(currentHandPosition1, currentHandPosition2)
            .multiplyScalar(0.5);
            
        const offset = new THREE.Vector3()
            .copy(this.initialObjectDirection)
            .multiplyScalar(p)
            .applyQuaternion(handRot);
            
        const newPosition = midpoint.add(offset);

        this._setWorldTransform(this.target, newPosition, newRotation, newScale);
    }

    attachTargetOne(ctl) {
        // Object3D.attach acts like Unity's SetParent(transform, true)
        ctl.attach(this.target);
    }

    /**
     * Helper to set world position, rotation, and scale on an Object3D
     * @private
     */
    _setWorldTransform(object, worldPosition, worldQuaternion, worldScale) {
        if (object.parent) {
            object.parent.updateMatrixWorld(true);

            // Set Position
            const localPos = worldPosition.clone();
            object.parent.worldToLocal(localPos);
            object.position.copy(localPos);

            // Set Quaternion
            const parentWorldQuat = new THREE.Quaternion();
            object.parent.getWorldQuaternion(parentWorldQuat);
            parentWorldQuat.invert();
            object.quaternion.copy(worldQuaternion).premultiply(parentWorldQuat);

            // Set Scale
            const parentWorldScale = new THREE.Vector3();
            object.parent.getWorldScale(parentWorldScale);
            object.scale.copy(worldScale).divide(parentWorldScale);
        } else {
            object.position.copy(worldPosition);
            object.quaternion.copy(worldQuaternion);
            object.scale.copy(worldScale);
        }
    }
}
