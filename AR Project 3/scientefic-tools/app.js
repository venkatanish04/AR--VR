import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.145.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.145.0/examples/jsm/controls/OrbitControls.js';
import Renderer from './renderer.js';
import MainCamera from './cameras/mainCamera.js';
import SolarSystem from './models/solarSystem.js';
import { HandTracker } from './handTracking.js';
import * as TWEEN from 'https://cdn.jsdelivr.net/npm/@tweenjs/tween.js@18.6.4/dist/tween.esm.js';

console.log('Starting Solar System Application...');

// Get the containeraa
const container = document.getElementById('canvas-container');
if (!container) {
    console.error('Could not find canvas container');
    throw new Error('Could not find canvas container');
}

// Initialize scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000033);

// Initialize camera
const camera = new MainCamera();

// Initialize renderer
const rendererInstance = new Renderer(container);
const renderer = rendererInstance.renderer;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// Add lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1);
sunLight.position.set(0, 10, 0);
sunLight.castShadow = true;
scene.add(sunLight);

// Initialize controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 20;
controls.maxDistance = 100;
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI / 2;

// Create solar system
console.log('Creating solar system...');
const solarSystem = new SolarSystem(scene, camera, renderer);
solarSystem.controls = controls;

// Setup click events
solarSystem.setupClickEvents(camera, renderer);

// webcam initialization
let webcamStream = null;
const webcamElement = document.getElementById('webcam');
let handTracker = null;


async function initWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: {
        width: 640,
        height: 480,
        frameRate: { ideal: 30 }
      } 
    });
    webcamStream = stream;
    webcamElement.srcObject = stream;
    await webcamElement.play();
    console.log('Webcam initialized successfully');
    return stream;
  } catch (error) {
    console.error('Error accessing webcam:', error);
    document.getElementById('error-message').innerText = 'Webcam not working: ' + error.message;
    document.getElementById('error-message').style.display = 'block';
    throw error;
  }
}

// Initialize hand tracking
async function startHandTracking(stream) {
    console.log('Initializing hand tracking...');
    try {
      handTracker = new HandTracker(scene, camera, solarSystem, stream);
      
      // Make handTracker globally available for sensitivity controls
      window.handTracker = handTracker;
      
      await handTracker.start();
      
      // // Set callback for throw detection
      // handTracker.setThrowCallback((position, velocity) => {
      //   console.log('Throw gesture detected!', position, velocity);
      //   if (solarSystem.planetEnvironment && solarSystem.planetEnvironment.isInUpdateLoop) {
      //     solarSystem.planetEnvironment.throwBall();
      //   }
      // });
      
      // Dispatch event for UI components that need to know hand tracking is ready
      window.dispatchEvent(new Event('hand-tracking-ready'));
      
      console.log('Hand tracking initialized successfully');
      
      // Add hand tracker reference to solarSystem for access in planet environment
      solarSystem.handTracker = handTracker;
      
      // Setup gesture toggle button
      // setupGestureToggleButton();
      
      return handTracker;
    } catch (error) {
      console.error('Failed to start hand tracking:', error);
      document.getElementById('error-message').innerText = 'Hand tracking failed: ' + error.message;
      document.getElementById('error-message').style.display = 'block';
      throw error;
    }
}

// Setup toggle gesture button

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    TWEEN.update();
    // physics.update();
    solarSystem.update();
    renderer.render(scene, camera);
}


// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    camera.updateAspect();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Initialize everything


// Show hand tracking status to user
function showHandTrackingStatus(message, isError = false) {
  const statusElement = document.createElement('div');
  statusElement.style.position = 'fixed';
  statusElement.style.bottom = '140px';
  statusElement.style.right = '10px';
  statusElement.style.padding = '5px 10px';
  statusElement.style.borderRadius = '5px';
  statusElement.style.color = 'white';
  statusElement.style.background = isError ? 'rgba(255,0,0,0.7)' : 'rgba(0,0,0,0.7)';
  statusElement.style.zIndex = '1000';
  statusElement.style.fontSize = '12px';
  statusElement.textContent = message;
  document.body.appendChild(statusElement);
  
  setTimeout(() => {
    document.body.removeChild(statusElement);
  }, 5000);
}

// Initialize everything
async function main() {
    try {
        animate();
        
        // Initialize webcam and hand tracking
        try {
            const stream = await initWebcam();
            const tracker = await startHandTracking(stream);
            showHandTrackingStatus('Hand tracking active! Make gestures with your hand.');
        } catch (error) {
            console.warn('Hand tracking initialization failed:', error);
            showHandTrackingStatus('Hand tracking not available. Using keyboard/mouse controls.', true);
            
            // Hide gesture controls panel if hand tracking fails
            const gestureControls = document.getElementById('gesture-controls');
            if (gestureControls) gestureControls.style.display = 'none';
            
            const toggleBtn = document.getElementById('toggle-gestures');
            if (toggleBtn) toggleBtn.style.display = 'none';
        }
    } catch (error) {
        console.error('Initialization failed:', error);
        document.getElementById('error-message').innerText = 'Initialization failed: ' + error.message;
        document.getElementById('error-message').style.display = 'block';
    }
}

// Start the application
main();
