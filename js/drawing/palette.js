import * as THREE from 'three';

export class Palette extends THREE.Group {
    constructor(radius = 0.5, swatchSize = 0.1) {
        super();

        /*
        naplps_black        (0, 0, 0)           → 0x000000
        naplps_gray1        (32, 32, 32)        → 0x202020
        naplps_gray2        (64, 64, 64)        → 0x404040
        naplps_gray3        (96, 96, 96)        → 0x606060
        naplps_gray4        (128, 128, 128)     → 0x808080
        naplps_gray5        (160, 160, 160)     → 0xA0A0A0
        naplps_gray6        (192, 192, 192)     → 0xC0C0C0
        naplps_gray7        (224, 224, 224)     → 0xE0E0E0
        naplps_blue         (0, 0, 255)         → 0x0000FF
        naplps_blue_magenta (180, 0, 252)       → 0xB400FC
        naplps_pinkish_red  (252, 0, 144)       → 0xFC0090
        naplps_orange_red   (252, 72, 0)        → 0xFC4800
        naplps_yellow       (255, 255, 0)       → 0xFFFF00
        naplps_yellow_green (72, 252, 0)        → 0x48FC00
        naplps_greenish     (0, 252, 144)       → 0x00FC90
        naplps_bluegreen    (0, 180, 252)       → 0x00B4FC
        naplps_white        (255, 255, 255)     → 0xFFFFFF        
        */

        this.colors = [
            { name: 'Black', hex: 0x000000 },       // 12 o'clock
            { name: 'Gray2', hex: 0x404040 },       // 1 o'clock
            { name: 'Gray4', hex: 0x808080 },       // 2 o'clock
            { name: 'Blue', hex: 0x0000FF },        // 3 o'clock
            { name: 'BlueMagenta', hex: 0xB400FC }, // 4 o'clock
            { name: 'PinkishRed', hex: 0xFC0090 },  // 5 o'clock
            { name: 'OrangeRed', hex: 0xFC4800 },   // 6 o'clock
            { name: 'Yellow', hex: 0xFFFF00 },      // 7 o'clock
            { name: 'YellowGreen', hex: 0x48FC00 }, // 8 o'clock
            { name: 'Greenish', hex: 0x00FC90 },    // 9 o'clock
            { name: 'BlueGreen', hex: 0x00B4FC },   // 10 o'clock
            { name: 'White', hex: 0xFFFFFF }        // 11 o'clock
        ];

        this.radius = radius;
        this.swatchSize = swatchSize;
        this.swatches = [];
        this.selectedIndex = 0;

        this._createSwatches();
    }

    _createSwatches() {
        const geometry = new THREE.CircleGeometry(this.swatchSize, 16);
        const whiteRimGeo = new THREE.RingGeometry(this.swatchSize, this.swatchSize * 1.1, 16);
        const blackRimGeo = new THREE.RingGeometry(this.swatchSize * 1.1, this.swatchSize * 1.2, 16);

        const whiteRimMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        });
        const blackRimMat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        });

        for (let i = 0; i < this.colors.length; i++) {
            // Clock position: 12 o'clock is up (negative Z in default view)
            // Angle starts at top and goes clockwise
            const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
            const x = Math.cos(angle) * this.radius;
            const y = Math.sin(angle) * this.radius;

            const material = new THREE.MeshBasicMaterial({
                color: this.colors[i].hex,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false
            });

            // Create swatch group to hold color circle and rims
            const swatchGroup = new THREE.Group();
            swatchGroup.position.set(x, y, 0);
            swatchGroup.userData = { index: i, color: this.colors[i] };

            // Black outer rim (render first/behind)
            const blackRim = new THREE.Mesh(blackRimGeo, blackRimMat);
            blackRim.renderOrder = 997;
            swatchGroup.add(blackRim);

            // White inner rim
            const whiteRim = new THREE.Mesh(whiteRimGeo, whiteRimMat);
            whiteRim.renderOrder = 998;
            swatchGroup.add(whiteRim);

            // Color circle on top
            const swatch = new THREE.Mesh(geometry, material);
            swatch.renderOrder = 999;
            swatchGroup.add(swatch);

            this.swatches.push(swatchGroup);
            this.add(swatchGroup);
        }

        // Create selection indicator
        const ringGeo = new THREE.RingGeometry(this.swatchSize * 1.1, this.swatchSize * 1.3, 16);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        });
        this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
        this.selectionRing.renderOrder = 1000;
        this.add(this.selectionRing);
        this._updateSelectionRing();
    }

    _updateSelectionRing() {
        const swatch = this.swatches[this.selectedIndex];
        this.selectionRing.position.copy(swatch.position);
    }

    /**
     * Select a color by index (0-11)
     * @param {number} index
     */
    select(index) {
        this.selectedIndex = Math.max(0, Math.min(11, index));
        this._updateSelectionRing();
    }

    /**
     * Get the currently selected color
     * @returns {{ name: string, hex: number }}
     */
    getSelectedColor() {
        return this.colors[this.selectedIndex];
    }

    /**
     * Get the selected color as a THREE.Color
     * @returns {THREE.Color}
     */
    getSelectedThreeColor() {
        return new THREE.Color(this.colors[this.selectedIndex].hex);
    }

    /**
     * Check if a world position hits a swatch and select it
     * @param {THREE.Vector3} worldPosition
     * @param {number} [threshold] - Hit distance threshold
     * @returns {boolean} True if a swatch was hit
     */
    hitTest(worldPosition, threshold = 0.1) {
        const localPos = this.worldToLocal(worldPosition.clone());
        localPos.z = 0; // Flatten to palette plane

        for (let i = 0; i < this.swatches.length; i++) {
            const swatchPos = this.swatches[i].position;
            const dist = localPos.distanceTo(swatchPos);
            if (dist < this.swatchSize + threshold) {
                this.select(i);
                return true;
            }
        }
        return false;
    }
}
