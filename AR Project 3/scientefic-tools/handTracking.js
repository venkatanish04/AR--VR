import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.145.0/build/three.module.js';
// import { PlanetEnvironment } from './planetEnvironment.js';
import SolarSystem from './models/solarSystem.js';

export class HandTracker {
  constructor(scene, camera, solarSystem, webcamStream, loadingCallback = null) {
    // Core properties
    this.scene = scene;
    this.camera = camera;
    this.solarSystem = solarSystem;
    this.stream = webcamStream;
    this.loadingCallback = loadingCallback;
    this.currentGesture = 'idle';

    // Video element setup
    this.video = document.getElementById('webcam') || this.createVideoElement();
    
    // For two-finger tap we remove single finger tap vars.
    this.lastFingerAngle = null;
    this.tapStarted = false;
    this.tapCount = 0;
    this.tapTimer = null;

    // Hand tracking state
    this.handpose = null;
    this.predictions = [];
    this.isTracking = false;
    
    // Gesture history buffers
    this.lastPositions = [];          // For tap detection
    this.lastPalmPositions = [];      // For throw velocity calculation
    this.maxPalmHistory = 5;
    
    // Gesture thresholds (you may adjust these)
    this.gestureThresholds = {
      throw: 1.3,
      pinch: 0.5,
      tap: 0.04,
      grab: 0.08,
      rotation: 0.9
    };
    // Calibration for mapping video coordinates
    this.calibration = {
      offsetX: 0,       // Adjust if video feed is shifted horizontally
      offsetY: 0,       // Adjust if video feed is shifted vertically
      scaleFactorX: 1,  // Horizontal scaling factor
      scaleFactorY: 1   // Vertical scaling factor (if needed)
    };

    this.indexFingerHistory = [];
    this.smoothingWindow = 5; // Average over 5 frames

    // Gesture state object (we only use the common ones now)
    this.gestureState = {
      isPinching: false,
      pinchStartDistance: 0,
      pinchStartZoom: 0,
      lastPinchDistance: 0,
      isGrabbing: false,
      lastGrabTime: 0,
      isRotating: false,
      lastRotationTime: 0,
      rotationStartPosition: null,
      tapDetected: false,
      lastTapTime: 0,
      tapInProgress: false
    };

    this.smoothingFactors = {
      position: 0.3,
      zoom: 0.7
    };

    this.frameControl = {
      lastFrameTime: 0,
      targetFPS: 15,
      frameInterval: 1000 / 30,
      frameSkip: false
    };

    // Debug visualization
    this.debug = {
      enabled: true,
      handMarkers: [],
      gestureIndicator: null,
      lastDetectedGesture: null,
      gestureOverlay: null
    };

    // Initialize tap state variables for two-finger tap detection
    this.lastIndexFingerAngle = null;

    this.createStatusOverlay();
  }

  // ---------------------------
  // Public API Methods
  // ---------------------------
  handlePickup() {
    const env = this.solarSystem?.planetEnvironment;
    // If the user set a callback, use it:
    if (typeof this.pickupCallback === 'function') {
      this.pickupCallback();
    }
    // Otherwise, fall back to the planetEnvironment’s pickupBall():
    else if (env && typeof env.pickupBall === 'function') {
      env.pickupBall();
    }
  }

  setThrowCallback(callback) {
    this.throwCallback = callback;
  }
  setPickupCallback(callback) {
    this.pickupCallback = callback;
  }

  async start() {
    try {
      this.reportProgress(10, "Loading HandPose model");

      if (!window.handpose) {
        throw new Error('Handpose model not loaded. Make sure the script is included.');
      }

      this.handpose = await window.handpose.load({
        maxContinuousChecks: 13,
        detectionConfidence: 0.8,
        iouThreshold: 0.4,
        scoreThreshold: 0.5
      });

      this.reportProgress(30, "Initializing video stream");

      if (!this.stream) {
        throw new Error('Webcam stream not provided');
      }

      this.video.srcObject = this.stream;
      await this.setupVideoPlayback();

      this.reportProgress(70, "Starting tracking");
      this.isTracking = true;

      if (this.debug.enabled) {
        this.createDebugVisuals();
      }

      this.track();
      this.reportProgress(100, "Hand tracking ready");

    } catch (error) {
      console.error('HandTracker initialization failed:', error);
      this.reportProgress(0, `Error: ${error.message}`);
      throw error;
    }
  }

  stop() {
    this.isTracking = false;

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    if (this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(track => track.stop());
      this.video.srcObject = null;
    }
    this.lastPositions = [];
    this.lastPalmPositions = [];
    this.cleanupDebugVisuals();
    if (this.debug.gestureOverlay?.parentNode) {
      this.debug.gestureOverlay.parentNode.removeChild(this.debug.gestureOverlay);
    }
  }

  toggleTracking(enabled) {
    this.isTracking = enabled;
    if (enabled) {
      this.track();
      console.log('Hand tracking enabled');
    } else {
      console.log('Hand tracking paused');
      this.hideDebugVisuals();
    }
  }


  // ---------------------------
  // Smoothing Helper
  // ---------------------------
  getSmoothedIndexFinger(rawCoord) {
    this.indexFingerHistory.push(rawCoord);
    if (this.indexFingerHistory.length > this.smoothingWindow) {
      this.indexFingerHistory.shift();
    }
    let sumX = 0, sumY = 0, sumZ = 0;
    for (const coord of this.indexFingerHistory) {
      sumX += coord[0];
      sumY += coord[1];
      sumZ += coord[2];
    }
    const count = this.indexFingerHistory.length;
    return [sumX / count, sumY / count, sumZ / count];
  }

  // ---------------------------
  // Gesture Detection
  // ---------------------------
  // Returns true if the index and middle fingers are extended while the ring and pinky are not.
  isTwoFingersExtended(landmarks) {
    return this.isFingerExtended(landmarks, 5, 8) &&    // Index extended
           this.isFingerExtended(landmarks, 9, 12) &&   // Middle extended
           !this.isFingerExtended(landmarks, 13, 16) &&  // Ring not extended
           !this.isFingerExtended(landmarks, 17, 20);     // Pinky not extended
  }

  // Returns true if the index finger is pointing upward.
  isIndexFingerPointingUp(landmarks) {
    const palm = landmarks[0];
    const indexTip = landmarks[8];
    const dx = indexTip[0] - palm[0];
    const dy = indexTip[1] - palm[1];
    // In image space, y increases downward so a finger pointing up has a negative dy.
    return (dy < -5 && Math.abs(dx) < 0.3 * Math.abs(dy));
  }
  // Only returns true when thumb, index, middle, ring, and pinky are all extended
areAllFingersOpen(landmarks) {
  return this.isFingerExtended(landmarks, 1, 4) &&   // Thumb
         this.isFingerExtended(landmarks, 5, 8) &&   // Index
         this.isFingerExtended(landmarks, 9, 12) &&  // Middle
         this.isFingerExtended(landmarks, 13, 16) && // Ring
         this.isFingerExtended(landmarks, 17, 20);   // Pinky
}

  distance3D(a, b) {
    return Math.sqrt(
      Math.pow(a[0] - b[0], 2) +
      Math.pow(a[1] - b[1], 2) +
      Math.pow(a[2] - b[2], 2)
    );
  }

  // Add this function inside your HandTracker class
  attemptPlanetSelectionOrderedHorizontal(landmarks) {
    // Use the index finger (tip at landmark 8) for horizontal mapping.
    const indexFinger = landmarks[8];
    const rawX = indexFinger[0];
  
    // Normalize the x coordinate relative to the video width using calibration.
    let normalizedX = (rawX - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
    normalizedX = Math.max(0, Math.min(normalizedX, 1)); // Clamp between 0 and 1
  
    // Map the normalized x coordinate to a planet index from the SolarSystem’s planetOrder array.
    const order = this.solarSystem.planetOrder;
    // Multiply by the length to get an index, then use floor and clamp if needed.
    const planetIndex = Math.min(Math.floor(normalizedX * order.length), order.length - 1);
    const planetName = order[planetIndex];
    
    console.debug(`Horizontal Mapping -> Raw X: ${rawX}, NormalizedX: ${normalizedX.toFixed(2)}, Mapped Planet Index: ${planetIndex} (${planetName}).`);
  
    // Retrieve the planet mesh using the SolarSystem's planets Map.
    if (this.solarSystem.planets.has(planetName)) {
      const planetData = this.solarSystem.planets.get(planetName);
      const planetMesh = planetData.mesh;
  
      // Call the highlight function on the SolarSystem instance.
      this.solarSystem.highlightPlanet(planetMesh);
      // Save a reference for entering the planet if a tap completes.
      this.solarSystem.currentlyHighlightedOrderedPlanet = planetMesh;
      
      return true;
    }
    
    return false;
  }

  attemptPlanetSelectionOrderedTwoFingers(landmarks) {
    if (!this.solarSystem) return false;
    
    // 1. Compute the average x coordinate from index (landmark 8) and middle finger (landmark 12)
    const indexFinger = landmarks[8];
    const middleFinger = landmarks[12];
    const avgX = (indexFinger[0] + middleFinger[0]) / 2;
    
    // 2. Normalize using video dimensions and calibration values.
    let normalizedX = (avgX - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
    normalizedX = Math.max(0, Math.min(normalizedX, 1));  // Clamp between 0 and 1
    
    // Debug: log normalized value and computed index.
    const order = this.solarSystem.planetOrder ||
      ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
    const planetIndex = Math.min(order.length - 1, Math.floor(normalizedX * order.length));
    const planetName = order[planetIndex];
    console.debug(`Normalized X: ${normalizedX.toFixed(2)}, Planet Index: ${planetIndex} (${planetName})`);
    
    // 3. If the planet exists in the SolarSystem, highlight it.
    if (this.solarSystem.planets.has(planetName)) {
      const planetData = this.solarSystem.planets.get(planetName);
      const planetMesh = planetData.mesh;
      
      if (typeof this.solarSystem.highlightPlanet === 'function') {
        this.solarSystem.highlightPlanet(planetMesh);
      }
      
      // Save currently highlighted planet for use with three-finger entry.
      this.solarSystem.currentlyHighlightedOrderedPlanet = planetMesh;
      return true;
    }
    return false;
  }
  
    
    isThreeFingersExtended(landmarks) {
      // Check if index, middle, and ring fingers are extended.
      const indexExtended = this.isFingerExtended(landmarks, 5, 8);
      const middleExtended = this.isFingerExtended(landmarks, 9, 12);
      const ringExtended = this.isFingerExtended(landmarks, 13, 16);
      
      // Optionally: require that thumb and pinky are NOT extended.
      const thumbNotExtended = !this.isFingerExtended(landmarks, 1, 4);
      // const pinkyNotExtended = !this.isFingerExtended(landmarks, 17, 20);
      
      return indexExtended && middleExtended && ringExtended && thumbNotExtended 
    }
    
  
    attemptPlanetSelectionOrderedThreeFingers(landmarks) {
      if (!this.solarSystem) return false;
      
      // 1. Compute the average x coordinate from the index (landmark 8) and middle finger (landmark 12)
      const indexFinger = landmarks[8];
      const middleFinger = landmarks[12];
      const avgX = (indexFinger[0] + middleFinger[0]) / 2;
      
      // 2. Normalize using video dimensions and calibration values.
      let normalizedX = (avgX - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
      normalizedX = Math.max(0, Math.min(normalizedX, 1)); // Clamp between 0 and 1
      
      // Debug: log normalized value and computed index.
      const order = this.solarSystem.planetOrder || 
        ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
      const planetIndex = Math.min(order.length - 1, Math.floor(normalizedX * order.length));
      const planetName = order[planetIndex];
      console.debug(`Normalized X: ${normalizedX.toFixed(2)}, Planet Index: ${planetIndex} (${planetName})`);
      
      // 3. If the planet exists in the SolarSystem, highlight it.
      if (this.solarSystem.planets.has(planetName)) {
        const planetData = this.solarSystem.planets.get(planetName);
        const planetMesh = planetData.mesh;
        
        if (typeof this.solarSystem.highlightPlanet === 'function') {
          this.solarSystem.highlightPlanet(planetMesh);
        }
        
        // 4. Check for the three-finger gesture.
        // Use a flag so that this entry event is processed only once per gesture occurrence.
        if (this.isThreeFingersExtended(landmarks) && !this.gestureState.threeFingerTapHandled) {
          this.gestureState.threeFingerTapHandled = true;
          console.log(`Three-finger gesture detected on ${planetName}`);
          
          if (typeof this.solarSystem.enterPlanet === 'function') {
            this.solarSystem.enterPlanet(planetMesh);
          }
          
          // Reset the flag after a short timeout (adjust delay as needed).
          setTimeout(() => { this.gestureState.threeFingerTapHandled = false; }, 500);
          return true;
        }
      }
      
      return false;
    }
    
  // Returns true if middle, ring, and pinky fingers are all extended
  areMidRingPinkyExtended(landmarks) {
  return this.isFingerExtended(landmarks, 9, 12) ||   // Middle
         this.isFingerExtended(landmarks, 13, 16) ||  // Ring
         this.isFingerExtended(landmarks, 17, 20) &&(!this.isFingerExtended(landmarks, 1, 4) && !this.isFingerExtended(landmarks, 5, 8));    // Pinky
}

  
  
  // ---------------------------
  // Main Gesture Detection
  // ---------------------------
  detectAndHandleGestures(landmarks, timestamp) {
    const env = this.solarSystem?.planetEnvironment;
    const indexFinger = landmarks[8];
    
    // Priority 1: Three-finger entry gesture
    if (!env?.character && this.isThreeFingersExtended(landmarks)) {
      // Use a flag so that the three-finger entry is processed only once per gesture occurrence.
      if (!this.gestureState.threeFingerEntryProcessed) {
        this.gestureState.threeFingerEntryProcessed = true;
        this.solarSystem.enterPlanet(this.solarSystem.currentlyHighlightedOrderedPlanet);
        // shorten debounce so it feels snappier
        setTimeout(() => {
          this.gestureState.threeFingerEntryProcessed = false;
        }, 300);
      }
      this.currentGesture = 'threeFingerEntry';
      return 'ThreeFingerEntry';
    }
    
    // Priority 2: Two-finger highlighting and tap
    if (!env?.character && this.isTwoFingersExtended(landmarks)) {
      this.currentGesture = 'tapping';
      // Update highlighted planet based on horizontal movement.
      this.attemptPlanetSelectionOrderedTwoFingers(landmarks);
      return 'Tap';
    } else {
      if (this.currentGesture === 'tapping') {
        this.tapCount = 0;
        this.tapStarted = false;
        this.currentGesture = 'idle';
      }
    }
    
    // Priority 3: Other gestures (pinch, grab, rotate)
    if (
      !this.areMidRingPinkyExtended(landmarks) &&
      this.detectPinchZoom(landmarks[4], indexFinger, landmarks)
    ) {
      if (this.currentGesture !== 'pinching') {
        this.currentGesture = 'pinching';
        console.log("Gesture: Pinch/Zoom detected.");
      }
      return 'Pinch/Zoom';
    }
    
    // Reset pinch state if we leave it
    if (
      this.currentGesture === 'pinching' &&
      !this.areMidRingPinkyExtended(landmarks) &&
      !this.detectPinchZoom(landmarks[4], indexFinger, landmarks)
    ) {
      this.currentGesture = 'idle';
    }
    if (
      env?.character &&
      !env.isHoldingBall &&     // hand not already holding
      !env.ballThrown &&        // ball is on the ground
      this.detectGrab(landmarks, timestamp)
    ) {
      if (this.currentGesture !== 'grabbing') {
        this.currentGesture = 'grabbing';
        console.log("Gesture: Grab detected.");
        this.handlePickup();
      }
      return 'Grab';
    }
    
    if (this.currentGesture === 'grabbing' && !this.detectGrab(landmarks, timestamp)) {
      this.currentGesture = 'idle';
    }

    // 5) THROW: open hand (five fingers) + velocity
  // —————————————
    if (env?.character && env.isHoldingBall && this.areFiveFingersExtended(landmarks)) {
      // compute smoothed palm velocity
      const velocity = this.computeThrowVelocity();
      if (velocity.length() > this.gestureThresholds.throw) {
        if (this.currentGesture !== 'throwing') {
          this.currentGesture = 'throwing';
          console.log("Gesture: Throw detected", velocity);
          // call your throw callback or planetEnvironment.throwBall
          if (typeof this.throwCallback === 'function') {
            this.throwCallback(velocity);
          } else if (typeof env.throwBall === 'function') {
            env.throwBall(velocity);
          }
        }
        return 'Throw';
      }
    }
    
    if (this.areAllFingersOpen(landmarks)) {
      if (this.currentGesture !== 'rotating') {
        this.currentGesture = 'rotating';
        console.log("Gesture: Rotate detected.");
      }
      this.handleRotation(landmarks);
      return 'Rotate';
    }
    
    if (this.currentGesture === 'rotating' && !this.areAllFingersOpen(landmarks)) {
      this.currentGesture = 'idle';
    }
    
    return this.currentGesture || 'idle';
  }
  
    // Only returns true when thumb, index, middle, ring and pinky are all extended
  areFiveFingersExtended(landmarks) {
    return this.isFingerExtended(landmarks, 1, 4) &&   // Thumb
           this.isFingerExtended(landmarks, 5, 8) &&   // Index
           this.isFingerExtended(landmarks, 9, 12) &&  // Middle
           this.isFingerExtended(landmarks, 13, 16) && // Ring
           this.isFingerExtended(landmarks, 17, 20);   // Pinky
  }

  // ---------------------------
  // (Keep your existing pinch, grab, rotate, and other helper functions as-is)
  // ---------------------------
  detectPinchZoom(thumb, indexFinger, landmarks) {
    const thumbPos = new THREE.Vector3(thumb[0], thumb[1], thumb[2]);
    const indexPos = new THREE.Vector3(indexFinger[0], indexFinger[1], indexFinger[2]);
    const dist = thumbPos.distanceTo(indexPos);
    const normDist = dist / this.video.width;
    if (this.areAllFingersOpen(landmarks)) {
      if (this.gestureState.isPinching) {
        this.gestureState.isPinching = false;
      }
      return false;
    }
    if (!this.gestureState.isPinching && normDist < this.gestureThresholds.pinch) {
      this.gestureState.isPinching = true;
      this.gestureState.pinchStartDistance = normDist;
      if (this.solarSystem?.controls) {
        this.gestureState.pinchStartZoom = 
          this.solarSystem.controls.target.distanceTo(this.camera.position);
      }
      return true;
    }
    if (this.gestureState.isPinching) {
      if (normDist > this.gestureThresholds.pinch * 2) {
        this.gestureState.isPinching = false;
      } else {
        this.handlePinchZoom(normDist);
        return true;
      }
    }
    return false;
  }

  handlePinchZoom(normDist) {
    let zoomFactor = normDist / this.gestureState.pinchStartDistance;
    zoomFactor = Math.pow(zoomFactor, 1.2);
    zoomFactor = Math.max(0.5, Math.min(2.0, zoomFactor));
    const dampedZoomFactor = 1.0 + (zoomFactor - 1.0) * this.smoothingFactors.zoom;
    if (this.solarSystem?.controls) {
      const minZoom = 3;
      const maxZoom = 150;
      const targetDist = Math.max(minZoom, Math.min(maxZoom, this.gestureState.pinchStartZoom / dampedZoomFactor));
      const direction = new THREE.Vector3().subVectors(this.camera.position, this.solarSystem.controls.target).normalize();
      const newPos = this.solarSystem.controls.target.clone().add(direction.multiplyScalar(targetDist));
      this.camera.position.lerp(newPos, 0.1);
      this.camera.lookAt(this.solarSystem.controls.target);
      if (typeof this.solarSystem.controls.update === 'function') {
        this.solarSystem.controls.update();
      }
    }
  }

  detectGrab(landmarks, timestamp) {
    // 1) Only allow grab when index+middle are extended and ring+pinky are not
    if (!this.isTwoFingersExtended(landmarks)) {
      // reset if we were in a grab state
      if (this.gestureState.isGrabbing) {
        this.gestureState.isGrabbing = false;
        console.log("Grab state reset (not two‑finger).");
      }
      return false;
    }
  
    // 2) Debounce so it only fires once per gesture
    const sinceLast = timestamp - this.gestureState.lastGrabTime;
    if (!this.gestureState.isGrabbing && sinceLast > 500) {
      this.gestureState.isGrabbing = true;
      this.gestureState.lastGrabTime = timestamp;
      console.log("Two‑finger grab detected.");
  
      // 3) Invoke pickup
      if (typeof this.pickupCallback === 'function') {
        this.pickupCallback();
      } else if (this.solarSystem?.planetEnvironment && 
                 !this.solarSystem.planetEnvironment.isHoldingBall) {
        this.solarSystem.planetEnvironment.pickupBall();
      }
  
      return true;
    }
  
    return false;
  }
  
  

  handleRotation(landmarks) {
    const palm = landmarks[0];
    const x = (palm[0] / this.video.width) * 2 - 1;
    const y = -((palm[1] / this.video.height) * 2 - 1);
    const current = new THREE.Vector2(x, y);
    if (!this.lastPalmScreenPos) {
      this.lastPalmScreenPos = current.clone();
      return;
    }
    const delta = current.clone().sub(this.lastPalmScreenPos);
    if (delta.length() < 0.005) return;
    const rotateSpeed = 1.5;
    const controls = this.solarSystem?.controls;
    if (controls) {
      if (typeof controls.rotateLeft === 'function') {
        controls.rotateLeft(delta.x * rotateSpeed);
        controls.rotateUp(delta.y * rotateSpeed);
        if (typeof controls.update === 'function') {
          controls.update();
        }
      } else {
        const target = controls.target || new THREE.Vector3(0, 0, 0);
        const offset = new THREE.Vector3().subVectors(this.camera.position, target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta -= delta.x * rotateSpeed;
        spherical.phi -= delta.y * rotateSpeed;
        spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi));
        offset.setFromSpherical(spherical);
        this.camera.position.copy(target).add(offset);
        this.camera.lookAt(target);
      }
    }
    this.lastPalmScreenPos = current;
  }

  // ---------------------------
  // Helper Methods (Video, Smoothing, Data Conversion)
  // ---------------------------
  createVideoElement() {
    const video = document.createElement('video');
    video.id = 'webcam';
    video.autoplay = true;
    video.playsInline = true;
    video.style.display = 'none';
    document.body.appendChild(video);
    return video;
  }

  async setupVideoPlayback() {
    return new Promise((resolve) => {
      this.video.onloadedmetadata = () => {
        this.video.play().then(resolve);
      };
    });
  }

  updatePositionHistory(landmarks) {
    this.lastPositions.unshift(landmarks.map(p => [...p]));
    if (this.lastPositions.length > 5) {
      this.lastPositions.pop();
    }
    const palmPos3D = this.getSmoothedPalmPosition(landmarks);
    this.lastPalmPositions.unshift(palmPos3D.clone());
    if (this.lastPalmPositions.length > this.maxPalmHistory) {
      this.lastPalmPositions.pop();
    }
  }

  getSmoothedPalmPosition(landmarks) {
    const palmBase = landmarks[0];
    const palmNorm = new THREE.Vector3(
      (palmBase[0] / this.video.width) * 2 - 1,
      -(palmBase[1] / this.video.height) * 2 + 1,
      0.5
    );
    const palmPos3D = palmNorm.clone().unproject(this.camera);
    if (this.lastSmoothedPosition) {
      palmPos3D.lerp(this.lastSmoothedPosition, this.smoothingFactors.position);
    }
    this.lastSmoothedPosition = palmPos3D.clone();
    return palmPos3D;
  }

  computeThrowVelocity() {
    if (this.lastPalmPositions.length < 2) {
      return new THREE.Vector3(0, 0, 0);
    }
    let velocity = new THREE.Vector3();
    for (let i = 0; i < this.lastPalmPositions.length - 1; i++) {
      const diff = new THREE.Vector3().subVectors(this.lastPalmPositions[i], this.lastPalmPositions[i + 1]);
      velocity.add(diff);
    }
    velocity.divideScalar(this.lastPalmPositions.length - 1);
    velocity.multiplyScalar(10);
    velocity.z = -velocity.z;
    return velocity;
  }

  resetGestureStates() {
    this.gestureState.isPinching = false;
    this.gestureState.isGrabbing = false;
    this.gestureState.isRotating = false;
    this.lastPalmPositions = [];
    this.lastFourFingerMidpoint = null;
  }

  handleTrackingError() {
    this.isTracking = false;
    setTimeout(() => {
      if (!this.isTracking) {
        console.log('Restarting hand tracking...');
        this.isTracking = true;
        this.track();
      }
    }, 2000);
  }

  reportProgress(progress, message) {
    console.log(`Hand Tracking: ${message} (${progress}%)`);
    if (typeof this.loadingCallback === 'function') {
      this.loadingCallback(progress, message);
    }
  }

  // ---------------------------
  // Data Conversion Helpers
  // ---------------------------
  extractFingerData(landmarks) {
    const fingerDefinitions = [
      { base: 1, tip: 4 },
      { base: 5, tip: 8 },
      { base: 9, tip: 12 },
      { base: 13, tip: 16 },
      { base: 17, tip: 20 }
    ];
    return fingerDefinitions.map(({ base, tip }) => ({
      tipPosition: this.convertToNormalizedPosition(landmarks[tip]),
      basePosition: this.convertToNormalizedPosition(landmarks[base]),
      extended: this.isFingerExtended(landmarks, base, tip),
      tipVelocity: this.calculateTipVelocity(tip, landmarks)
    }));
  }

  calculateTipVelocity(tipIndex, landmarks) {
    if (this.lastPositions.length < 2) {
      return { x: 0, y: 0, z: 0 };
    }
    const currentTip = landmarks[tipIndex];
    const prevTip = this.lastPositions[0][tipIndex];
    return {
      x: (currentTip[0] - prevTip[0]) / 0.033,
      y: (currentTip[1] - prevTip[1]) / 0.033,
      z: (currentTip[2] - prevTip[2]) / 0.033
    };
  }

  convertToNormalizedPosition(point) {
    return {
      x: (point[0] / this.video.width) * 2 - 1,
      y: -((point[1] / this.video.height) * 2 - 1),
      z: point[2]
    };
  }

  calculatePalmNormal(landmarks) {
    const v1 = [
      landmarks[5][0] - landmarks[17][0],
      landmarks[5][1] - landmarks[17][1],
      landmarks[5][2] - landmarks[17][2]
    ];
    const v2 = [
      landmarks[9][0] - landmarks[0][0],
      landmarks[9][1] - landmarks[0][1],
      landmarks[9][2] - landmarks[0][2]
    ];
    const normal = {
      x: v1[1] * v2[2] - v1[2] * v2[1],
      y: v1[2] * v2[0] - v1[0] * v2[2],
      z: v1[0] * v2[1] - v1[1] * v2[0]
    };
    const length = Math.sqrt(normal.x ** 2 + normal.y ** 2 + normal.z ** 2);
    if (length > 0) {
      normal.x /= length;
      normal.y /= length;
      normal.z /= length;
    }
    return normal;
  }

  // ---------------------------
  // Planet Selection via Raycasting (unused here for tap mode)
  // ---------------------------
  attemptPlanetSelection(indexFinger) {
    if (!this.solarSystem) return false;
    const indexNDC = {
      x: (indexFinger[0] / this.video.width) * 2 - 1,
      y: -((indexFinger[1] / this.video.height) * 2 - 1)
    };
    try {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(indexNDC.x, indexNDC.y), this.camera);
      const planetObjects = [];
      this.scene.traverse(object => {
        if (object.isPlanet || (object.userData?.isPlanet) || (object.name && this.isPlanetName(object.name))) {
          planetObjects.push(object);
        }
      });
      if (planetObjects.length === 0) return false;
      if (this.debug.enabled) {
        this.showTapFeedback(indexFinger);
      }
      const intersects = raycaster.intersectObjects(planetObjects, true);
      if (intersects.length > 0) {
        const selectedPlanet = this.findActualPlanet(intersects[0].object);
        if (selectedPlanet && this.solarSystem.enterPlanet) {
          try {
            this.solarSystem.enterPlanet(selectedPlanet);
            return true;
          } catch (error) {
            console.error('Error entering planet:', error);
          }
        }
      }
    } catch (error) {
      console.error("Planet selection error:", error);
    }
    return false;
  }

  isPlanetName(name) {
    const planetNames = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'sun'];
    return planetNames.includes(name.toLowerCase());
  }

  findActualPlanet(object) {
    let current = object;
    while (current && !current.isPlanet && !(current.userData?.isPlanet) && current.parent) {
      current = current.parent;
    }
    return (current?.isPlanet || current?.userData?.isPlanet) ? current : object;
  }

  // ---------------------------
  // Debug Visualization
  // ---------------------------
  createStatusOverlay() {
    if (this.debug.gestureOverlay) return;
    this.debug.gestureOverlay = document.createElement('div');
    Object.assign(this.debug.gestureOverlay.style, {
      position: 'fixed',
      bottom: '140px',
      right: '180px',
      padding: '5px 10px',
      borderRadius: '5px',
      color: 'white',
      background: 'rgba(0,0,0,0.7)',
      zIndex: '1000',
      fontSize: '12px'
    });
    this.debug.gestureOverlay.textContent = 'No gesture detected';
    document.body.appendChild(this.debug.gestureOverlay);
  }

  updateGestureOverlay(gesture) {
    if (!this.debug.gestureOverlay) return;
    if (gesture && gesture !== this.debug.lastDetectedGesture) {
      this.debug.gestureOverlay.textContent = `Gesture: ${gesture}`;
      this.debug.gestureOverlay.style.background = 'rgba(0,128,0,0.7)';
      setTimeout(() => {
        if (this.debug.gestureOverlay) {
          this.debug.gestureOverlay.style.background = 'rgba(0,0,0,0.7)';
        }
      }, 1000);
    } else if (!gesture) {
      this.debug.gestureOverlay.textContent = 'No gesture detected';
    }
    this.debug.lastDetectedGesture = gesture;
  }

  createDebugVisuals() {
    for (let i = 0; i < 21; i++) {
      const geometry = new THREE.SphereGeometry(0.02, 8, 8);
      const material = new THREE.MeshBasicMaterial({ color: this.getLandmarkColor(i) });
      const marker = new THREE.Mesh(geometry, material);
      marker.visible = false;
      this.scene.add(marker);
      this.debug.handMarkers.push(marker);
    }
    const indicatorGeom = new THREE.SphereGeometry(0.04, 16, 16);
    const indicatorMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    this.debug.gestureIndicator = new THREE.Mesh(indicatorGeom, indicatorMat);
    this.debug.gestureIndicator.visible = false;
    this.scene.add(this.debug.gestureIndicator);
  }

  getLandmarkColor(index) {
    switch (index) {
      case 0: return 0xff0000; // Palm - red
      case 4: return 0x00ff00; // Thumb - green
      case 8: return 0x0000ff; // Index - blue
      default: return 0xffff00; // Others - yellow
    }
  }

  updateDebugVisuals(landmarks, gesture) {
    for (let i = 0; i < landmarks.length && i < this.debug.handMarkers.length; i++) {
      const marker = this.debug.handMarkers[i];
      const screenPos = this.landmarkToScreenPosition(landmarks[i]);
      marker.position.copy(screenPos);
      marker.visible = true;
      marker.material.color.set(this.getLandmarkColor(i));
    }
    if (this.debug.gestureIndicator && gesture) {
      const palmPos = this.landmarkToScreenPosition(landmarks[0]);
      this.debug.gestureIndicator.position.copy(palmPos);
      this.debug.gestureIndicator.visible = true;
      this.debug.gestureIndicator.material.color.set(this.getGestureColor(gesture));
      const scale = 1 + 0.2 * Math.sin(performance.now() / 200);
      this.debug.gestureIndicator.scale.set(scale, scale, scale);
    }
    if (landmarks[8]) {
      const indexPos = this.landmarkToScreenPosition(landmarks[8]);
      if (!this.debug.indexLabel) {
        this.debug.indexLabel = document.createElement('div');
        this.debug.indexLabel.style.position = 'absolute';
        this.debug.indexLabel.style.color = 'white';
        this.debug.indexLabel.style.fontSize = '12px';
        document.body.appendChild(this.debug.indexLabel);
      }
      const smoothed = this.getSmoothedIndexFinger(landmarks[8]);
      let normalizedX = (smoothed[0] - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
      normalizedX = Math.min(Math.max(normalizedX, 0), 1);
      const order = this.solarSystem?.planetOrder || [];
      const planetIndex = order.length ? Math.floor(normalizedX * order.length) : -1;
      this.debug.indexLabel.innerText = `NormX: ${normalizedX.toFixed(2)}\nPlanetIdx: ${planetIndex}`;
      this.debug.indexLabel.style.left = `${indexPos.x * window.innerWidth / 2 + window.innerWidth / 2}px`;
      this.debug.indexLabel.style.top = `${-indexPos.y * window.innerHeight / 2 + window.innerHeight / 2 - 20}px`;
    }
  }

  getGestureColor(gesture) {
    switch (gesture) {
      case 'Pinch/Zoom': return 0x00ff00;
      case 'Tap': return 0x0000ff;
      case 'Grab': return 0xff00ff;
      case 'Throw': return 0xff0000;
      default: return 0xffff00;
    }
  }

  landmarkToScreenPosition(landmark) {
    const xNorm = (landmark[0] / this.video.width) * 2 - 1;
    const yNorm = -(landmark[1] / this.video.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(xNorm, yNorm), this.camera);
    const distance = 5;
    const position = new THREE.Vector3();
    position.copy(this.camera.position).add(raycaster.ray.direction.multiplyScalar(distance));
    return position;
  }

  showTapFeedback(indexFinger) {
    if (!this.debug.gestureIndicator) return;
    const tapPos = this.landmarkToScreenPosition(indexFinger);
    this.debug.gestureIndicator.position.copy(tapPos);
    this.debug.gestureIndicator.material.color.set(0x00ffff);
    this.debug.gestureIndicator.visible = true;
    const originalScale = this.debug.gestureIndicator.scale.clone();
    const startTime = performance.now();
    const duration = 500;
    const animatePulse = (time) => {
      const elapsed = time - startTime;
      const progress = Math.min(1.0, elapsed / duration);
      const scale = progress < 0.5 ? 1 + progress * 2 : 3 - (progress - 0.5) * 4;
      this.debug.gestureIndicator.scale.set(scale, scale, scale);
      if (progress < 1.0) {
        requestAnimationFrame(animatePulse);
      } else {
        this.debug.gestureIndicator.scale.copy(originalScale);
      }
    };
    requestAnimationFrame(animatePulse);
  }

  hideDebugVisuals() {
    this.debug.handMarkers.forEach(marker => marker.visible = false);
    if (this.debug.gestureIndicator) {
      this.debug.gestureIndicator.visible = false;
    }
  }

  cleanupDebugVisuals() {
    this.debug.handMarkers.forEach(marker => this.scene.remove(marker));
    this.debug.handMarkers = [];
    if (this.debug.gestureIndicator) {
      this.scene.remove(this.debug.gestureIndicator);
      this.debug.gestureIndicator = null;
    }
  }

  extractFingerData(landmarks) {
    const fingerDefinitions = [
      { base: 1, tip: 4 },
      { base: 5, tip: 8 },
      { base: 9, tip: 12 },
      { base: 13, tip: 16 },
      { base: 17, tip: 20 }
    ];
    return fingerDefinitions.map(({ base, tip }) => ({
      tipPosition: this.convertToNormalizedPosition(landmarks[tip]),
      basePosition: this.convertToNormalizedPosition(landmarks[base]),
      extended: this.isFingerExtended(landmarks, base, tip),
      tipVelocity: this.calculateTipVelocity(tip, landmarks)
    }));
  }

  calculateTipVelocity(tipIndex, landmarks) {
    if (this.lastPositions.length < 2) {
      return { x: 0, y: 0, z: 0 };
    }
    const currentTip = landmarks[tipIndex];
    const prevTip = this.lastPositions[0][tipIndex];
    return {
      x: (currentTip[0] - prevTip[0]) / 0.033,
      y: (currentTip[1] - prevTip[1]) / 0.033,
      z: (currentTip[2] - prevTip[2]) / 0.033
    };
  }

  convertToNormalizedPosition(point) {
    return {
      x: (point[0] / this.video.width) * 2 - 1,
      y: -((point[1] / this.video.height) * 2 - 1),
      z: point[2]
    };
  }

  calculatePalmNormal(landmarks) {
    const v1 = [
      landmarks[5][0] - landmarks[17][0],
      landmarks[5][1] - landmarks[17][1],
      landmarks[5][2] - landmarks[17][2]
    ];
    const v2 = [
      landmarks[9][0] - landmarks[0][0],
      landmarks[9][1] - landmarks[0][1],
      landmarks[9][2] - landmarks[0][2]
    ];
    const normal = {
      x: v1[1] * v2[2] - v1[2] * v2[1],
      y: v1[2] * v2[0] - v1[0] * v2[2],
      z: v1[0] * v2[1] - v1[1] * v2[0]
    };
    const length = Math.sqrt(normal.x ** 2 + normal.y ** 2 + normal.z ** 2);
    if (length > 0) {
      normal.x /= length;
      normal.y /= length;
      normal.z /= length;
    }
    return normal;
  }

  // ---------------------------
  // Planet Selection (via raycasting, not used for tap mode)
  // ---------------------------
  attemptPlanetSelection(indexFinger) {
    if (!this.solarSystem) return false;
    const indexNDC = {
      x: (indexFinger[0] / this.video.width) * 2 - 1,
      y: -((indexFinger[1] / this.video.height) * 2 - 1)
    };
    try {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(indexNDC.x, indexNDC.y), this.camera);
      const planetObjects = [];
      this.scene.traverse(object => {
        if (object.isPlanet || (object.userData?.isPlanet) || (object.name && this.isPlanetName(object.name))) {
          planetObjects.push(object);
        }
      });
      if (planetObjects.length === 0) return false;
      if (this.debug.enabled) {
        this.showTapFeedback(indexFinger);
      }
      const intersects = raycaster.intersectObjects(planetObjects, true);
      if (intersects.length > 0) {
        const selectedPlanet = this.findActualPlanet(intersects[0].object);
        if (selectedPlanet && this.solarSystem.enterPlanet) {
          try {
            this.solarSystem.enterPlanet(selectedPlanet);
            return true;
          } catch (error) {
            console.error('Error entering planet:', error);
          }
        }
      }
    } catch (error) {
      console.error("Planet selection error:", error);
    }
    return false;
  }

  isPlanetName(name) {
    const planetNames = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'sun'];
    return planetNames.includes(name.toLowerCase());
  }

  findActualPlanet(object) {
    let current = object;
    while (current && !current.isPlanet && !(current.userData?.isPlanet) && current.parent) {
      current = current.parent;
    }
    return (current?.isPlanet || current?.userData?.isPlanet) ? current : object;
  }

  // ---------------------------
  // Debug Visualization
  // ---------------------------
  createStatusOverlay() {
    if (this.debug.gestureOverlay) return;
    this.debug.gestureOverlay = document.createElement('div');
    Object.assign(this.debug.gestureOverlay.style, {
      position: 'fixed',
      bottom: '140px',
      right: '180px',
      padding: '5px 10px',
      borderRadius: '5px',
      color: 'white',
      background: 'rgba(0,0,0,0.7)',
      zIndex: '1000',
      fontSize: '12px'
    });
    this.debug.gestureOverlay.textContent = 'No gesture detected';
    document.body.appendChild(this.debug.gestureOverlay);
  }

  updateGestureOverlay(gesture) {
    if (!this.debug.gestureOverlay) return;
    if (gesture && gesture !== this.debug.lastDetectedGesture) {
      this.debug.gestureOverlay.textContent = `Gesture: ${gesture}`;
      this.debug.gestureOverlay.style.background = 'rgba(0,128,0,0.7)';
      setTimeout(() => {
        if (this.debug.gestureOverlay) {
          this.debug.gestureOverlay.style.background = 'rgba(0,0,0,0.7)';
        }
      }, 1000);
    } else if (!gesture) {
      this.debug.gestureOverlay.textContent = 'No gesture detected';
    }
    this.debug.lastDetectedGesture = gesture;
  }

  createDebugVisuals() {
    for (let i = 0; i < 21; i++) {
      const geometry = new THREE.SphereGeometry(0.02, 8, 8);
      const material = new THREE.MeshBasicMaterial({ color: this.getLandmarkColor(i) });
      const marker = new THREE.Mesh(geometry, material);
      marker.visible = false;
      this.scene.add(marker);
      this.debug.handMarkers.push(marker);
    }
    const indicatorGeom = new THREE.SphereGeometry(0.04, 16, 16);
    const indicatorMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    this.debug.gestureIndicator = new THREE.Mesh(indicatorGeom, indicatorMat);
    this.debug.gestureIndicator.visible = false;
    this.scene.add(this.debug.gestureIndicator);
  }

  getLandmarkColor(index) {
    switch (index) {
      case 0: return 0xff0000;
      case 4: return 0x00ff00;
      case 8: return 0x0000ff;
      default: return 0xffff00;
    }
  }

  updateDebugVisuals(landmarks, gesture) {
    for (let i = 0; i < landmarks.length && i < this.debug.handMarkers.length; i++) {
      const marker = this.debug.handMarkers[i];
      const screenPos = this.landmarkToScreenPosition(landmarks[i]);
      marker.position.copy(screenPos);
      marker.visible = true;
      marker.material.color.set(this.getLandmarkColor(i));
    }
    if (this.debug.gestureIndicator && gesture) {
      const palmPos = this.landmarkToScreenPosition(landmarks[0]);
      this.debug.gestureIndicator.position.copy(palmPos);
      this.debug.gestureIndicator.visible = true;
      this.debug.gestureIndicator.material.color.set(this.getGestureColor(gesture));
      const scale = 1 + 0.2 * Math.sin(performance.now() / 200);
      this.debug.gestureIndicator.scale.set(scale, scale, scale);
    }
    if (landmarks[8]) {
      const indexPos = this.landmarkToScreenPosition(landmarks[8]);
      if (!this.debug.indexLabel) {
        this.debug.indexLabel = document.createElement('div');
        this.debug.indexLabel.style.position = 'absolute';
        this.debug.indexLabel.style.color = 'white';
        this.debug.indexLabel.style.fontSize = '12px';
        document.body.appendChild(this.debug.indexLabel);
      }
      const smoothed = this.getSmoothedIndexFinger(landmarks[8]);
      let normalizedX = (smoothed[0] - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
      normalizedX = Math.min(Math.max(normalizedX, 0), 1);
      const order = this.solarSystem?.planetOrder || [];
      const planetIndex = order.length ? Math.floor(normalizedX * order.length) : -1;
      this.debug.indexLabel.innerText = `NormX: ${normalizedX.toFixed(2)}\nPlanetIdx: ${planetIndex}`;
      this.debug.indexLabel.style.left = `${indexPos.x * window.innerWidth / 2 + window.innerWidth / 2}px`;
      this.debug.indexLabel.style.top = `${-indexPos.y * window.innerHeight / 2 + window.innerHeight / 2 - 20}px`;
    }
  }

  getGestureColor(gesture) {
    switch (gesture) {
      case 'Pinch/Zoom': return 0x00ff00;
      case 'Tap': return 0x0000ff;
      case 'Grab': return 0xff00ff;
      case 'Throw': return 0xff0000;
      default: return 0xffff00;
    }
  }

  landmarkToScreenPosition(landmark) {
    const xNorm = (landmark[0] / this.video.width) * 2 - 1;
    const yNorm = -(landmark[1] / this.video.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(xNorm, yNorm), this.camera);
    const distance = 5;
    const position = new THREE.Vector3();
    position.copy(this.camera.position).add(raycaster.ray.direction.multiplyScalar(distance));
    return position;
  }

  showTapFeedback(indexFinger) {
    if (!this.debug.gestureIndicator) return;
    const tapPos = this.landmarkToScreenPosition(indexFinger);
    this.debug.gestureIndicator.position.copy(tapPos);
    this.debug.gestureIndicator.material.color.set(0x00ffff);
    this.debug.gestureIndicator.visible = true;
    const originalScale = this.debug.gestureIndicator.scale.clone();
    const startTime = performance.now();
    const duration = 500;
    const animatePulse = (time) => {
      const elapsed = time - startTime;
      const progress = Math.min(1.0, elapsed / duration);
      const scale = progress < 0.5 ? 1 + progress * 2 : 3 - (progress - 0.5) * 4;
      this.debug.gestureIndicator.scale.set(scale, scale, scale);
      if (progress < 1.0) {
        requestAnimationFrame(animatePulse);
      } else {
        this.debug.gestureIndicator.scale.copy(originalScale);
      }
    };
    requestAnimationFrame(animatePulse);
  }

  hideDebugVisuals() {
    this.debug.handMarkers.forEach(marker => marker.visible = false);
    if (this.debug.gestureIndicator) {
      this.debug.gestureIndicator.visible = false;
    }
  }

  cleanupDebugVisuals() {
    this.debug.handMarkers.forEach(marker => this.scene.remove(marker));
    this.debug.handMarkers = [];
    if (this.debug.gestureIndicator) {
      this.scene.remove(this.debug.gestureIndicator);
      this.debug.gestureIndicator = null;
    }
  }
  isFingerExtended(landmarks, baseIndex, tipIndex) {
    // If checking the thumb, use a slightly different calculation.
    if (tipIndex === 4) {
      const thumbTip = landmarks[4];
      const thumbBase = landmarks[1];
      const palmBase = landmarks[0];
      const thumbPalmDist = this.distance3D(thumbTip, palmBase);
      const basePalmDist = this.distance3D(thumbBase, palmBase);
      return thumbPalmDist > basePalmDist * 1.2;
    }
    // For other fingers, assume the finger is extended if its tip is above (i.e. has a lower y value)
    // than the middle joint.
    const tip = landmarks[tipIndex];
    const mid = landmarks[tipIndex - 2];
    return tip[1] < mid[1];
  }
  
  // ---------------------------
  // Main Tracking Loop
  // ---------------------------
  async track() {
    if (!this.isTracking) return;
    const now = performance.now();
    const elapsed = now - this.frameControl.lastFrameTime;
    if (elapsed < this.frameControl.frameInterval && this.frameControl.frameSkip) {
      requestAnimationFrame(() => this.track());
      return;
    }
    this.frameControl.lastFrameTime = now;
    this.frameControl.frameSkip = !this.frameControl.frameSkip;
    try {
      this.predictions = await this.handpose.estimateHands(this.video);
      if (this.predictions.length > 0) {
        const hand = this.predictions[0];
        const landmarks = hand.landmarks;
        this.updatePositionHistory(landmarks);
        const detectedGesture = this.detectAndHandleGestures(landmarks, now);
        this.updateGestureOverlay(detectedGesture);
        if (this.debug.enabled) {
          this.updateDebugVisuals(landmarks, detectedGesture);
        }
      } else {
        this.resetGestureStates();
        this.updateGestureOverlay(null);
        this.hideDebugVisuals();
      }
      requestAnimationFrame(() => this.track());
    } catch (error) {
      console.error('Tracking error:', error);
      this.handleTrackingError();
    }
  }
}
