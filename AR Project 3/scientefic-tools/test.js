import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.145.0/build/three.module.js';
// import { PlanetEnvironment } from './planetEnvironment.js';
import  SolarSystem  from './models/solarSystem.js';

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
        
        // Gesture thresholds (normalized values)
        this.gestureThresholds = {
            throw: 0.99,
            pinch: 0.22,
            tap: 0.03,
            grab: 0.08,
            rotation: 0.9
        };
        this.calibration = {
            offsetX: 0,       // Adjust if the video feed is shifted horizontally
            offsetY: 0,       // Adjust if the video feed is shifted vertically
            scaleFactorX: 1,  // Scale factor for the horizontal mapping
            scaleFactorY: 1   // (Optional) for vertical if needed
          };

        this.indexFingerHistory = [];
        this.smoothingWindow = 5; // average over 5 frames (adjust as needed)
    
        
        // Gesture states
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
        
        // Smoothing and performance
        this.smoothingFactors = {
            position: 0.3,
            zoom: 0.7
        };
        
        // Frame rate control
        this.frameControl = {
            lastFrameTime: 0,
            targetFPS: 30,
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
        // In the constructor, add:
        this.lastIndexFingerDistance = null;
        this.tapStarted = false;
        this.tapCount = 0;
        this.tapTimer = null;
        // Initialize
        this.createStatusOverlay();
    }
    
    // =====================
    // Public API Methods
    // =====================
    
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
            this.reportProgress(0, Error: ${error.message});
            throw error;n
        }
    }
    
    stop() {
        this.isTracking = false;
        
        // Clean up media streams
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        
        if (this.video.srcObject) {
            this.video.srcObject.getTracks().forEach(track => track.stop());
            this.video.srcObject = null;
        }
        
        // Clear buffers
        this.lastPositions = [];
        this.lastPalmPositions = [];
        
        // Remove debug visuals
        this.cleanupDebugVisuals();
        
        // Remove overlay
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

    processVerticalTap(indexFinger) {
        // indexFinger: array [x, y, z] in raw pixel coordinates
        const currentY = indexFinger[1];
        const tapThreshold = 20;        // minimum difference in pixels to consider a tap event; adjust as needed
        const doubleTapWindow = 300;    // time window (ms) for a double tap
        
        // If we haven't got a reference yet, set it:
        if (this.lastFingerY === null) {
            this.lastFingerY = currentY;
            return false;
        }
        
        // Compute the vertical change (absolute difference)
        const dy = Math.abs(currentY - this.lastFingerY);
        // Update lastFingerY for next frame
        this.lastFingerY = currentY;
        
        // If vertical movement is significant, consider it as a tap event.
        if (dy > tapThreshold) {
            const now = performance.now();
            if (this.lastTapTimeVertical && (now - this.lastTapTimeVertical < doubleTapWindow)) {
                // Double tap detected
                console.log(Vertical double tap detected (dy=${dy}).);
                // Reset for next detection.
                this.lastTapTimeVertical = 0;
                return true;
            } else {
                // Record the tap event timestamp.
                this.lastTapTimeVertical = now;
            }
        }
        return false;
      }

      processIndexFingerTap(landmarks) {
        // Only process if the index finger is alone and pointing up.
        if (!this.isOnlyIndexFingerExtended(landmarks) || !this.isIndexFingerPointingUp(landmarks)) {
            // Not in tap mode; reset state.
            this.lastIndexFingerDistance = null;
            this.tapStarted = false;
            this.tapCount = 0;
            if (this.tapTimer) {
                clearTimeout(this.tapTimer);
                this.tapTimer = null;
            }
            return false;
        }
        
        const palm = landmarks[0];
        const indexTip = landmarks[8];
        const currentDistance = Math.hypot(indexTip[0] - palm[0], indexTip[1] - palm[1]);
        
        // Initialize baseline when finger is fully extended.
        if (this.lastIndexFingerDistance === null) {
            this.lastIndexFingerDistance = currentDistance;
        }
        
        // If the finger is bent, the distance will drop significantly.
        // For example, if the distance drops below 80% of the baseline, consider it a bend.
        const bentThreshold = 0.8;
        const straightThreshold = 0.95; // when re-extended, consider it "straight"
        
        let tapDetected = false;
        
        // Check if finger is bent.
        if (!this.tapStarted && currentDistance < this.lastIndexFingerDistance * bentThreshold) {
            this.tapStarted = true;
            // (Optional) Log the bending event.
            console.debug("Finger bent detected.");
        }
        
        // If a tap had started and the finger straightens.
        if (this.tapStarted && currentDistance > this.lastIndexFingerDistance * straightThreshold) {
            this.tapStarted = false;
            this.tapCount++;
            console.debug(Tap count increased to: ${this.tapCount});
            
            // Start or reset a timer to count double tap within a given window.
            if (this.tapTimer) clearTimeout(this.tapTimer);
            this.tapTimer = setTimeout(() => { this.tapCount = 0; }, 800); // 800ms window
            
            if (this.tapCount >= 2) {
                // Double tap detected.
                console.log("Double tap (bend-and-straight) detected.");
                this.tapCount = 0;
                clearTimeout(this.tapTimer);
                this.tapTimer = null;
                return true;
            }
        }
        
        // Optional: Update baseline if finger remains extended.
        if (currentDistance > this.lastIndexFingerDistance) {
            this.lastIndexFingerDistance = currentDistance;
        }
        
        return false;
      }
      
      

    getSmoothedIndexFinger(rawCoord) {
        // rawCoord is expected to be an array [x, y, z]
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
      
    
    /**
 * Checks whether the hand is in a closed fist configuration.
 * Compares the distance from the palm (landmark 0) to each fingertip (landmarks 4,8,12,16,20)
 * and considers the hand closed if all fingers are sufficiently near the palm.
 */
    /**
 * Checks whether the hand is in a closed fist configuration.
 * Uses the palm (landmark 0) as the reference and calculates hand size using landmark 9.
 * Then checks that all five fingertips (landmarks 4, 8, 12, 16, 20) are within a certain fraction of the hand size.
 */
    
    // NEW METHOD in HandTracker for ordered planet selection:
    attemptPlanetSelectionOrdered(indexFinger) {
        if (!this.solarSystem || !this.video.videoWidth || !this.video.videoHeight) return false;
        
        // Smooth the index finger position.
        const smoothed = this.getSmoothedIndexFinger(indexFinger);
        
        // Apply calibration offset and scaling on the x coordinate.
        let normalizedX = (smoothed[0] - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
        normalizedX = Math.min(Math.max(normalizedX, 0), 1);
        
        // Map normalized x to a planet index in the ordered array.
        const order = this.solarSystem.planetOrder;
        const planetIndex = Math.min(order.length - 1, Math.floor(normalizedX * order.length));
        const planetName = order[planetIndex];
        
        console.debug(Raw X: ${indexFinger[0]}, Smoothed X: ${smoothed[0]}, normalizedX: ${normalizedX.toFixed(2)}, planetIndex: ${planetIndex} (${planetName}).);
        
        // Retrieve the planet mesh.
        if (this.solarSystem.planets.has(planetName)) {
          const planetData = this.solarSystem.planets.get(planetName);
          const planetMesh = planetData.mesh;
          
          // Highlight the planet (draw a bright green ring).
          this.solarSystem.highlightPlanet(planetMesh);
          console.debug(Ordered Selection: ${planetName} is highlighted.);
          
          return true;
        }
        return false;
      }
      
      
      
      calibrateHandPosition() {
        // For instance, take the current index finger position as baseline:
        if (this.predictions.length > 0) {
          const hand = this.predictions[0];
          const indexFinger = hand.landmarks[8];
          // You might choose to average over several frames for stability.
          this.calibration.offsetX = indexFinger[0]; // Adjust as needed.
          console.log(Calibration complete. Baseline offsetX: ${this.calibration.offsetX});
          // You could do similar for offsetY if necessary.
        }
      }
      
      
  



    getHandsData() {
        if (!this.predictions?.length) return [];
        
        return this.predictions.map(pred => {
            const landmarks = pred.landmarks;
            return {
                handedness: pred.handedness,
                palmPosition: this.convertToNormalizedPosition(landmarks[0]),
                palmNormal: this.calculatePalmNormal(landmarks),
                fingers: this.extractFingerData(landmarks),
                confidence: pred.score,
                landmarks
            };
        });
    }
    
    // =====================
    // Core Tracking Logic
    // =====================
    
    async track() {
        if (!this.isTracking) return;
        
        // Frame rate control
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
                
                // Update position history
                this.updatePositionHistory(landmarks);
                
                // Detect and handle gestures
                const detectedGesture = this.detectAndHandleGestures(landmarks, now);
                
                // Update UI and debug visuals
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
    

    attemptPlanetSelectionOrderedVertical(indexFinger) {
        if (!this.solarSystem || !this.video.videoHeight) return false;
        
        // Use the vertical coordinate of the index finger.
        // For example, use the raw Y coordinate and subtract a calibration offset.
        let normalizedY = (indexFinger[1] - this.calibration.offsetY) / (this.video.videoHeight * this.calibration.scaleFactorY);
        
        // Clamp the value between 0 and 1.
        normalizedY = Math.min(Math.max(normalizedY, 0), 1);
        
        // Invert normalizedY so that a higher index finger (closer to the top of the video) results in a higher value.
        normalizedY = 1 - normalizedY;
        
        // Map normalizedY to a planet index. (For an ordered array like [mercury, venus, ...])
        const order = this.solarSystem.planetOrder;
        const planetIndex = Math.min(order.length - 1, Math.floor(normalizedY * order.length));
        const planetName = order[planetIndex];
        
        console.debug(Vertical Mapping -> Raw Y: ${indexFinger[1]}, normalizedY: ${normalizedY.toFixed(2)}, planetIndex: ${planetIndex} (${planetName}).);
        
        // Retrieve the planet mesh from the SolarSystem’s planets map.
        if (this.solarSystem.planets.has(planetName)) {
          const planetData = this.solarSystem.planets.get(planetName);
          const planetMesh = planetData.mesh;
          
          // Highlight the planet using your green ring method.
          this.solarSystem.highlightPlanet(planetMesh);
          
          // Save reference for entering.
          this.solarSystem.currentlyHighlightedOrderedPlanet = planetMesh;
          
          return true;
        }
        
        return false;
      }

      // Returns true if only the index finger is extended
        isOnlyIndexFingerExtended(landmarks) {
            return this.isFingerExtended(landmarks, 5, 8) &&  // Index finger extended
                !this.isFingerExtended(landmarks, 9, 12) && // Middle finger not extended
                !this.isFingerExtended(landmarks, 13, 16) && // Ring finger not extended
                !this.isFingerExtended(landmarks, 17, 20) && // Pinky not extended
                !this.isFingerExtended(landmarks, 1, 4);     // Thumb not extended
        }
        
        // Returns true if the index finger appears to be pointing upward.
        // This example compares the vector from the palm (landmark 0) to index finger tip (landmark 8)
        // and expects the vertical difference (dy) to be significantly negative.
        isIndexFingerPointingUp(landmarks) {
            const palm = landmarks[0];
            const indexTip = landmarks[8];
            const dx = indexTip[0] - palm[0];
            const dy = indexTip[1] - palm[1];
            // For a finger pointing upward (relative to the palm), dy should be negative.
            // Also require that the horizontal offset is small compared to the vertical change.
            if (dy < -10 && Math.abs(dx) < 0.2 * Math.abs(dy)) {
            return true;
            }
            return false;
        }
        processTwoFingerTap(landmarks) {
            // Compute average angle for index (landmark 8) and middle (landmark 12) fingers.
            const angleIndex = this.getFingerAngle(landmarks, 8);
            const angleMiddle = this.getFingerAngle(landmarks, 12);
            const avgAngle = (angleIndex + angleMiddle) / 2;
            
            // Define thresholds (in degrees).
            const verticalThreshold = 10;  // Within ±10° counts as vertical.
            const bentThreshold = 20;      // More than 20° away from vertical indicates a bend.
            
            // If the fingers are vertical (baseline state), update baseline.
            if (Math.abs(avgAngle) < verticalThreshold) {
              // If a tap was in progress, return that a tap has completed.
              if (this.tapStarted) {
                this.tapStarted = false;
                this.tapCount++;
                console.debug("Tap event detected. Tap count:", this.tapCount);
                
                // Start/reset the timer for counting taps.
                if (this.tapTimer) clearTimeout(this.tapTimer);
                this.tapTimer = setTimeout(() => {
                  this.tapCount = 0;
                }, 800); // 800ms window
                
                // If two taps are counted within the window, report a double tap.
                if (this.tapCount >= 2) {
                  console.log("Double tap (bend-and-straight) detected.");
                  this.tapCount = 0;
                  clearTimeout(this.tapTimer);
                  this.tapTimer = null;
                  return true;
                }
              }
              return false;
            }
            
            // If the fingers are not vertical, and if they have not been marked as bent yet, mark as bent.
            if (!this.tapStarted && Math.abs(avgAngle) > bentThreshold) {
              this.tapStarted = true;
              console.debug("Fingers bent detected.");
            }
            
            return false;
          }
          

        isTwoFingersExtended(landmarks) {
            return this.isFingerExtended(landmarks, 5, 8) &&     // Index extended
                   this.isFingerExtended(landmarks, 9, 12) &&    // Middle extended
                   !this.isFingerExtended(landmarks, 13, 16) &&   // Ring not extended
                   !this.isFingerExtended(landmarks, 17, 20);      // Pinky not extended
          }
  
  // Returns true if the index finger is extended.
      
    // =====================
    // Gesture Detection
    // =====================
    
    detectAndHandleGestures(landmarks, timestamp) {
        const palmPos3D = this.getSmoothedPalmPosition(landmarks);
        const thumb = landmarks[4];
        const indexFinger = landmarks[8];
        const env = this.solarSystem?.planetEnvironment;
      
        // -------------------------------
        // Priority: Check for other higher priority gestures (pinch, grab, rotate)
        // (Keep your existing pinch/grab/rotate logic here...)
       // Lower Priority: Tap Mode using two fingers (index & middle) extended and index pointing up.
        if (this.isTwoFingersExtended(landmarks) && this.isIndexFingerPointingUp(landmarks)) {
            // Set tap mode.
            if (this.currentGesture === 'idle' || this.currentGesture === 'tapping') {
            this.currentGesture = 'tapping';
            // Update highlighting based on horizontal movement.
            this.attemptPlanetSelectionOrderedHorizontal(indexFinger);
            }
            
            // Process double tap based on the two-finger bend-and-straight motion.
            if (this.processTwoFingerTap(landmarks)) {
            if (this.solarSystem.currentlyHighlightedOrderedPlanet) {
                console.log(Double tap confirmed on ${this.solarSystem.currentlyHighlightedOrderedPlanet.name}. Entering planet.);
                if (typeof this.solarSystem.enterPlanet === 'function') {
                this.solarSystem.enterPlanet(this.solarSystem.currentlyHighlightedOrderedPlanet);
                }
            }
            this.currentGesture = 'idle';
            }
            return 'Tap';
        } else {
            if (this.currentGesture === 'tapping') {
            this.tapCount = 0;
            this.tapStarted = false;
            this.currentGesture = 'idle';
            }
        }
          
        if (this.detectPinchZoom(thumb, indexFinger, landmarks)) {
          if (this.currentGesture !== 'pinching') {
            this.currentGesture = 'pinching';
            console.log("Gesture: Pinch/Zoom started");
          }
          return 'Pinch/Zoom';
        }
        if (this.currentGesture === 'pinching' && !this.detectPinchZoom(thumb, indexFinger, landmarks)) {
          this.currentGesture = 'idle';
        }
        if (env?.character && !env.isHoldingBall && this.detectGrab(landmarks, timestamp)) {
          if (this.currentGesture !== 'grabbing') {
            this.currentGesture = 'grabbing';
            console.log("Gesture: Grab (Pickup) detected");
            this.handlePickup();
          }
          return 'Grab';
        }
        if (this.currentGesture === 'grabbing' && !this.detectGrab(landmarks, timestamp)) {
          this.currentGesture = 'idle';
        }
        if (this.areAllFingersOpen(landmarks)) {
          if (this.currentGesture !== 'rotating') {
            this.currentGesture = 'rotating';
            console.log("Gesture: Rotate detected");
          }
          this.handleRotation(landmarks);
          return 'Rotate';
        }
        if (this.currentGesture === 'rotating' && !this.areAllFingersOpen(landmarks)) {
          this.currentGesture = 'idle';
        }
        // -------------------------------
        
        // Lower Priority: Tap/Selection using index finger only.
        
        // Default: return current gesture state.
        return this.currentGesture || 'idle';
      }
      
      
    
    
    detectPinchZoom(thumb, indexFinger, landmarks) {
        const thumbPos = new THREE.Vector3(thumb[0], thumb[1], thumb[2]);
        const indexPos = new THREE.Vector3(indexFinger[0], indexFinger[1], indexFinger[2]);
        const dist = thumbPos.distanceTo(indexPos);
        const normDist = dist / this.video.width;
        
        // Don't detect pinch if all fingers are open
        if (this.areAllFingersOpen(landmarks)) {
            if (this.gestureState.isPinching) {
                this.gestureState.isPinching = false;
            }
            return false;
        }
        
        // Start pinch
        if (!this.gestureState.isPinching && normDist < this.gestureThresholds.pinch) {
            this.gestureState.isPinching = true;
            this.gestureState.pinchStartDistance = normDist;
            
            if (this.solarSystem?.controls) {
                this.gestureState.pinchStartZoom = 
                    this.solarSystem.controls.target.distanceTo(this.camera.position);
            }
            return true;
        } 
        
        // Continue pinch
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
        zoomFactor = Math.pow(zoomFactor, 1.2); // Non-linear scaling
        zoomFactor = Math.max(0.5, Math.min(2.0, zoomFactor)); // Constrain
        
        const dampedZoomFactor = 1.0 + (zoomFactor - 1.0) * this.smoothingFactors.zoom;
        
        if (this.solarSystem?.controls) {
            const minZoom = 3;
            const maxZoom = 150;
            const targetDist = Math.max(minZoom, 
                               Math.min(maxZoom, 
                               this.gestureState.pinchStartZoom / dampedZoomFactor));
            
            const direction = new THREE.Vector3()
                .subVectors(this.camera.position, this.solarSystem.controls.target)
                .normalize();
            
            const newPos = this.solarSystem.controls.target.clone()
                .add(direction.multiplyScalar(targetDist));
            
            this.camera.position.lerp(newPos, 0.1);
            this.camera.lookAt(this.solarSystem.controls.target);
            
            if (typeof this.solarSystem.controls.update === 'function') {
                this.solarSystem.controls.update();
            }
        }
    }
    
    detectGrab(landmarks, timestamp) {
        if (!landmarks || landmarks.length !== 21) {
            console.log("🔍 Invalid landmarks data or incomplete landmarks.");
            return false;
        }
    
        const thumb = landmarks[4];
        const indexFinger = landmarks[8];
        const pinchDistance = this.distance3D(thumb, indexFinger);
    
        console.log(📐 Distance between thumb and index finger: ${pinchDistance});
    
        // Define a threshold for pinch close enough to simulate grabbing
        const max_pinchThreshold = 180;
        const min_pinchThreshold = 140 // You may need to adjust this based on observed values
    
        if (pinchDistance>190) {
            const timeSinceLastGrab = timestamp - this.gestureState.lastGrabTime;
            console.log(⏳ Time since last grab: ${timeSinceLastGrab}ms);
            if (!this.gestureState.isGrabbing && timeSinceLastGrab > 500) {
                this.gestureState.isGrabbing = true;
                this.gestureState.lastGrabTime = timestamp;
                console.log("🖐 Pinch detected (two fingers).");
    
                // Trigger pickupBall only if not holding already
                if (this.solarSystem?.planetEnvironment &&
                    !this.solarSystem.planetEnvironment.isHoldingBall) {
                    this.solarSystem.planetEnvironment.pickupBall();
                    console.log("🏀 Ball picked up successfully.");
                }
    
                return true;
            }
        } else {
            if (this.gestureState.isGrabbing) {
                console.log("🚫 Grab state reset (no pinch detected).");
                this.gestureState.isGrabbing = false;
            }
        }
    
        return false;
    }
    

    
    
    handleThrow(palmPos3D) {
        const env = this.solarSystem?.planetEnvironment;
        // Check if the ball is currently held and the hand is open
        if (!env?.isHoldingBall || !this.isHandOpen(this.predictions[0].landmarks)) {
            this.lastPalmPositions = [];
            console.log("Throw cancelled: Ball not held or hand not open.");
            return;
        }
    
        this.lastPalmPositions.unshift(palmPos3D.clone());
        if (this.lastPalmPositions.length > this.maxPalmHistory) {
            this.lastPalmPositions.pop();
        }
    
        if (this.lastPalmPositions.length > 1) {
            const velocity = this.computeThrowVelocity();
            env.throwBall(velocity);
            console.log(Throw executed with velocity: ${velocity.x}, ${velocity.y}, ${velocity.z});
    
            if (this.throwCallback) {
                this.throwCallback(palmPos3D, velocity);
            }
    
            this.lastPalmPositions = [];
        } else {
            console.log("Insufficient data for throw velocity calculation.");
        }
    }
    

    handlePickup() {
        const env = this.solarSystem?.planetEnvironment;
        if (env?.isHoldingBall) {
            console.log("Already holding the ball, no action taken.");
            return; // Already holding the ball, no need to pick up
        }
    
        // // Simulating a condition to pick up the ball, you may have specific conditions or triggers
        // // if (env && typeof env.pickupBall === 'function') {
            env.pickupBall();
            console.log("Pickup ball action executed.");
        // }
        // env.pickupdropball();
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
                // Fallback rotation logic
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
    
    // =====================
    // Helper Methods
    // =====================
    
    createVideoElement() {
        const video = document.createElement('video');
        video.id = 'webcam';
        video.autoplay = true;
        video.playsinline = true;
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
        // Store current landmarks
        this.lastPositions.unshift(landmarks.map(p => [...p]));
        if (this.lastPositions.length > 5) {
            this.lastPositions.pop();
        }
        
        // Store palm position for throw velocity
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
            const diff = new THREE.Vector3().subVectors(
                this.lastPalmPositions[i], 
                this.lastPalmPositions[i + 1]
            );
            velocity.add(diff);
        }
        
        velocity.divideScalar(this.lastPalmPositions.length - 1);
        velocity.multiplyScalar(10);
        velocity.z = -velocity.z; // Invert Z for Three.js coordinate system
        
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
        console.log(Hand Tracking: ${message} (${progress}%));
        if (typeof this.loadingCallback === 'function') {
            this.loadingCallback(progress, message);
        }
    }
    
    // =====================
    // Gesture Recognition
    // =====================
    
    isPointingWithIndexFinger(landmarks) {
        return this.isFingerExtended(landmarks, 5, 8) &&  // Index extended
               !this.isFingerExtended(landmarks, 9, 12) && // Middle not extended
               !this.isFingerExtended(landmarks, 13, 16) && // Ring not extended
               !this.isFingerExtended(landmarks, 17, 20);   // Pinky not extended
    }
    
    isHandOpen(landmarks) {
        const extendedCount = [
            this.isFingerExtended(landmarks, 5, 8),   // Index
            this.isFingerExtended(landmarks, 9, 12),  // Middle
            this.isFingerExtended(landmarks, 13, 16), // Ring
            this.isFingerExtended(landmarks, 17, 20)  // Pinky
        ].filter(Boolean).length;
        
        return extendedCount >= 4;
    }
    
    areAllFingersOpen(landmarks) {
        const extendedCount = [
            this.isFingerExtended(landmarks, 5, 8),   // Index
            this.isFingerExtended(landmarks, 9, 12),  // Middle
            this.isFingerExtended(landmarks, 13, 16), // Ring
            this.isFingerExtended(landmarks, 17, 20), // Pinky
            this.isFingerExtended(landmarks, 1, 4)    // Thumb
        ].filter(Boolean).length;
        
        return extendedCount >= 4;
    }
    
    isFingerExtended(landmarks, baseIndex, tipIndex) {
        if (tipIndex === 4) { // Thumb
            const thumbTip = landmarks[4];
            const thumbBase = landmarks[1];
            const palmBase = landmarks[0];
            const thumbPalmDist = this.distance3D(thumbTip, palmBase);
            const basePalmDist = this.distance3D(thumbBase, palmBase);
            return thumbPalmDist > basePalmDist * 1.2;
        }
        
        // Other fingers - check if tip is above middle joint
        const tip = landmarks[tipIndex];
        const mid = landmarks[tipIndex - 2];
        return tip[1] < mid[1];
    }
    
    distance3D(a, b) {
        return Math.sqrt(
            Math.pow(a[0] - b[0], 2) + 
            Math.pow(a[1] - b[1], 2) + 
            Math.pow(a[2] - b[2], 2)
        );
    }
    
    // =====================
    // Planet Selection
    // =====================
    
    attemptPlanetSelection(indexFinger) {
        if (!this.solarSystem) return false;
        
        // Get normalized device coordinates
        const indexNDC = {
            x: (indexFinger[0] / this.video.width) * 2 - 1,
            y: -((indexFinger[1] / this.video.height) * 2 - 1)
        };
        
        try {
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(new THREE.Vector2(indexNDC.x, indexNDC.y), this.camera);
            
            // Find planet objects in scene
            const planetObjects = [];
            this.scene.traverse(object => {
                if (object.isPlanet || 
                    (object.userData?.isPlanet) || 
                    (object.name && this.isPlanetName(object.name))) {
                    planetObjects.push(object);
                }
            });
            
            if (planetObjects.length === 0) return false;
            
            // Show visual feedback
            if (this.debug.enabled) {
                this.showTapFeedback(indexFinger);
            }
            
            // Check for intersections
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
        const planetNames = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 
                           'saturn', 'uranus', 'neptune', 'sun'];
        return planetNames.includes(name.toLowerCase());
    }
    
    findActualPlanet(object) {
        let current = object;
        
        while (current && 
              !current.isPlanet && 
              !(current.userData?.isPlanet) &&
              current.parent) {
            current = current.parent;
        }
        
        return (current?.isPlanet || current?.userData?.isPlanet) ? current : object;
    }
    
    // =====================
    // Debug Visualization
    // =====================
    
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
            this.debug.gestureOverlay.textContent = Gesture: ${gesture};
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
        // Create hand landmark markers
        for (let i = 0; i < 21; i++) {
            const geometry = new THREE.SphereGeometry(0.02, 8, 8);
            const material = new THREE.MeshBasicMaterial({ 
                color: this.getLandmarkColor(i) 
            });
            
            const marker = new THREE.Mesh(geometry, material);
            marker.visible = false;
            this.scene.add(marker);
            this.debug.handMarkers.push(marker);
        }
        
        // Create gesture indicator
        const indicatorGeom = new THREE.SphereGeometry(0.04, 16, 16);
        const indicatorMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        this.debug.gestureIndicator = new THREE.Mesh(indicatorGeom, indicatorMat);
        this.debug.gestureIndicator.visible = false;
        this.scene.add(this.debug.gestureIndicator);
    }
    
    getLandmarkColor(index) {
        switch(index) {
            case 0: return 0xff0000;  // Palm - red
            case 4: return 0x00ff00;   // Thumb - green
            case 8: return 0x0000ff;   // Index - blue
            default: return 0xffff00;  // Others - yellow
        }
    }
    
    updateDebugVisuals(landmarks, gesture) {
        // Update hand markers
        for (let i = 0; i < landmarks.length && i < this.debug.handMarkers.length; i++) {
            const marker = this.debug.handMarkers[i];
            const screenPos = this.landmarkToScreenPosition(landmarks[i]);
            
            marker.position.copy(screenPos);
            marker.visible = true;
            marker.material.color.set(this.getLandmarkColor(i));
        }
        
        // Update gesture indicator
        if (this.debug.gestureIndicator && gesture) {
            const palmPos = this.landmarkToScreenPosition(landmarks[0]);
            
            this.debug.gestureIndicator.position.copy(palmPos);
            this.debug.gestureIndicator.visible = true;
            this.debug.gestureIndicator.material.color.set(this.getGestureColor(gesture));
            
            // Add pulsing animation
            const scale = 1 + 0.2 * Math.sin(performance.now() / 200);
            this.debug.gestureIndicator.scale.set(scale, scale, scale);
        }

        // Additionally, show a text label near the index finger indicating the normalized x and computed planet.
        if (landmarks[8]) { // index finger tip
            const indexPos = this.landmarkToScreenPosition(landmarks[8]);
            if (!this.debug.indexLabel) {
                this.debug.indexLabel = document.createElement('div');
                this.debug.indexLabel.style.position = 'absolute';
                this.debug.indexLabel.style.color = 'white';
                this.debug.indexLabel.style.fontSize = '12px';
                document.body.appendChild(this.debug.indexLabel);
            }
            // Set text to show debug info. (You can adjust formatting as needed.)
            const smoothed = this.getSmoothedIndexFinger(landmarks[8]);
            let normalizedX = (smoothed[0] - this.calibration.offsetX) / (this.video.videoWidth * this.calibration.scaleFactorX);
            normalizedX = Math.min(Math.max(normalizedX, 0), 1);
            const order = this.solarSystem?.planetOrder || [];
            const planetIndex = order.length ? Math.floor(normalizedX * order.length) : -1;
            this.debug.indexLabel.innerText = NormX: ${normalizedX.toFixed(2)}\nPlanetIdx: ${planetIndex};
            // Position the label near the index finger (you might need to adjust for your layout)
            this.debug.indexLabel.style.left = ${indexPos.x * window.innerWidth / 2 + window.innerWidth / 2}px;
            this.debug.indexLabel.style.top = ${-indexPos.y * window.innerHeight / 2 + window.innerHeight / 2 - 20}px;
        }

    }
    
    getGestureColor(gesture) {
        switch(gesture) {
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
        
        const distance = 5; // Fixed distance from camera
        const position = new THREE.Vector3();
        position.copy(this.camera.position)
               .add(raycaster.ray.direction.multiplyScalar(distance));
        
        return position;
    }
    
    showTapFeedback(indexFinger) {
        if (!this.debug.gestureIndicator) return;
        
        const tapPos = this.landmarkToScreenPosition(indexFinger);
        this.debug.gestureIndicator.position.copy(tapPos);
        this.debug.gestureIndicator.material.color.set(0x00ffff);
        this.debug.gestureIndicator.visible = true;
        
        // Animate pulse
        const originalScale = this.debug.gestureIndicator.scale.clone();
        const startTime = performance.now();
        const duration = 500;
        
        const animatePulse = (time) => {
            const elapsed = time - startTime;
            const progress = Math.min(1.0, elapsed / duration);
            const scale = progress < 0.5 ? 
                1 + progress * 2 : 
                3 - (progress - 0.5) * 4;
            
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
    
    // =====================
    // Data Conversion
    // =====================
    
    extractFingerData(landmarks) {
        const fingerDefinitions = [
            { base: 1, tip: 4 },  // Thumb
            { base: 5, tip: 8 },  // Index
            { base: 9, tip: 12 }, // Middle
            { base: 13, tip: 16 }, // Ring
            { base: 17, tip: 20 }  // Pinky
        ];
        
        return fingerDefinitions.map(({base, tip}) => ({
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
            z: point[2] // Raw depth value
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
}