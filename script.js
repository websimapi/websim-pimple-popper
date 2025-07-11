import confetti from 'canvas-confetti';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const gameArea = document.getElementById('game-area');
const scoreEl = document.getElementById('score');
const loadingOverlay = document.getElementById('loading-overlay');
let score = 0;
let audioContext;
let popSoundBuffer;
let pluckSoundBuffer;
let audioInitialized = false;

// --- Three.js Setup ---
let scene, camera, renderer, faceMesh, controls;
let raycaster, mouse;
const pimples = [];
const ingrownHairs = [];
const MAX_PIMPLES = 15;
const MAX_INGROWN_HAIRS = 8;
let currentPluckingAction = null;
const PULL_THRESHOLD = 80; // pixels to drag for a successful pluck

function init3D() {
    scene = new THREE.Scene();
    scene.background = null; 

    const gameRect = gameArea.getBoundingClientRect();
    camera = new THREE.PerspectiveCamera(75, gameRect.width / gameRect.height, 0.1, 1000);
    camera.position.z = 2.5;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(gameRect.width, gameRect.height);
    gameArea.appendChild(renderer.domElement);
    
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 4;
    controls.target.set(0, -0.2, 0);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    loadFaceModel();

    // Event listeners for interaction
    gameArea.addEventListener('pointerdown', onPointerDown);
    gameArea.addEventListener('pointermove', onPointerMove);
    gameArea.addEventListener('pointerup', onPointerUp);
    gameArea.addEventListener('pointerleave', onPointerUp); // Treat leaving the area as pointer up
    window.addEventListener('resize', onWindowResize);
}

function loadFaceModel() {
    const loader = new GLTFLoader();
    // Using a different, more standard GLB model to ensure compatibility
    loader.load(
        'https://threejs.org/examples/models/gltf/LeePerrySmith/LeePerrySmith.glb',
        (gltf) => {
            faceMesh = gltf.scene;
            const skinTexture = new THREE.TextureLoader().load('skin.png');
            skinTexture.wrapS = THREE.RepeatWrapping;
            skinTexture.wrapT = THREE.RepeatWrapping;
            skinTexture.repeat.set(4, 4);

            const material = new THREE.MeshStandardMaterial({
                map: skinTexture,
                roughness: 0.6,
                metalness: 0.1,
            });

            faceMesh.traverse((child) => {
                if (child.isMesh) {
                    child.material = material;
                    // Flag the face mesh to distinguish from pimples
                    child.userData.isFace = true; 
                    // Store vertex data for pimple placement
                    child.geometry.computeVertexNormals();
                    child.geometry.setAttribute('initialPosition', child.geometry.attributes.position.clone());
                }
            });
            
            faceMesh.scale.set(0.7, 0.7, 0.7);
            faceMesh.position.y = -0.5;
            scene.add(faceMesh);
            loadingOverlay.style.display = 'none';
            startGame();
        },
        undefined,
        (error) => {
            console.error('An error happened while loading the model:', error);
            loadingOverlay.textContent = "Error loading model. Please refresh.";
        }
    );
}

function onWindowResize() {
    const gameRect = gameArea.getBoundingClientRect();
    if (gameRect.width > 0 && gameRect.height > 0) {
        camera.aspect = gameRect.width / gameRect.height;
        camera.updateProjectionMatrix();
        renderer.setSize(gameRect.width, gameRect.height);
    }
}

// --- Audio Setup ---
async function initializeAudio() {
    if (audioInitialized) return;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const popPromise = fetch('pop.mp3').then(res => res.arrayBuffer()).then(buffer => audioContext.decodeAudioData(buffer));
        const pluckPromise = fetch('pluck.mp3').then(res => res.arrayBuffer()).then(buffer => audioContext.decodeAudioData(buffer));

        [popSoundBuffer, pluckSoundBuffer] = await Promise.all([popPromise, pluckPromise]);
        
        audioInitialized = true;
    } catch (error) {
        console.error('Error initializing audio:', error);
    }
}

function playPopSound() {
    if (!audioInitialized || !popSoundBuffer) {
        console.log("Audio not ready");
        return;
    }
    // Resume context if it was suspended
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    const source = audioContext.createBufferSource();
    source.buffer = popSoundBuffer;
    source.connect(audioContext.destination);
    source.start(0);
}

function playPluckSound() {
    if (!audioInitialized || !pluckSoundBuffer) return;
    if (audioContext.state === 'suspended') audioContext.resume();
    
    const source = audioContext.createBufferSource();
    source.buffer = pluckSoundBuffer;
    source.connect(audioContext.destination);
    source.start(0);
}

// --- Pimple Logic ---
function createPimple() {
    if (!faceMesh || pimples.length >= MAX_PIMPLES) return;

    let targetMesh;
    // Traverse to find only the face mesh, not other pimples.
    faceMesh.traverse(child => { if(child.isMesh && child.userData.isFace) targetMesh = child; });
    if(!targetMesh) {
        console.error("Could not find face mesh to spawn pimple on.");
        return;
    }

    const positionAttribute = targetMesh.geometry.getAttribute('initialPosition');
    if (!positionAttribute) {
        console.error("Face mesh is missing 'initialPosition' attribute.");
        return;
    }
    const vertexIndex = Math.floor(Math.random() * positionAttribute.count);
    
    const pimplePosition = new THREE.Vector3().fromBufferAttribute(positionAttribute, vertexIndex);
    
    const pimpleSize = Math.random() * 0.03 + 0.04;
    const geometry = new THREE.SphereGeometry(pimpleSize, 16, 16);
    const material = new THREE.MeshPhongMaterial({ color: 0xff6b81, shininess: 80 });
    const pimpleMesh = new THREE.Mesh(geometry, material);

    pimpleMesh.position.copy(pimplePosition);
    pimpleMesh.userData.isPimple = true;
    pimpleMesh.userData.popped = false;

    faceMesh.add(pimpleMesh);
    pimples.push(pimpleMesh);
}

// --- Ingrown Hair Logic ---
function createIngrownHair() {
    if (!faceMesh || ingrownHairs.length >= MAX_INGROWN_HAIRS) return;

    let targetMesh;
    faceMesh.traverse(child => { if (child.isMesh && child.userData.isFace) targetMesh = child; });
    if (!targetMesh) return;

    const positionAttribute = targetMesh.geometry.getAttribute('initialPosition');
    if (!positionAttribute) return;
    
    const vertexIndex = Math.floor(Math.random() * positionAttribute.count);
    const hairPosition = new THREE.Vector3().fromBufferAttribute(positionAttribute, vertexIndex);

    const moundGeometry = new THREE.SphereGeometry(0.025, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const moundMaterial = new THREE.MeshStandardMaterial({ color: 0xdb8d7a, roughness: 0.8 });
    const moundMesh = new THREE.Mesh(moundGeometry, moundMaterial);

    const tipGeometry = new THREE.SphereGeometry(0.005, 8, 8);
    const tipMaterial = new THREE.MeshBasicMaterial({ color: 0x24170d });
    const tipMesh = new THREE.Mesh(tipGeometry, tipMaterial);
    tipMesh.position.y = 0.001; 

    const hairGroup = new THREE.Group();
    hairGroup.add(moundMesh);
    hairGroup.add(tipMesh);
    hairGroup.position.copy(hairPosition);
    hairGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hairPosition.clone().normalize());

    hairGroup.userData.isIngrownHair = true;
    hairGroup.userData.base = moundMesh;
    hairGroup.userData.tip = tipMesh;

    faceMesh.add(hairGroup);
    ingrownHairs.push(hairGroup);
}

function onPointerDown(event) {
    if (controls.isDragging) return;
    // User must click to start audio context
    if (!audioInitialized) {
        initializeAudio();
    }

    const intersects = getIntersects(event.clientX, event.clientY);
    if (!intersects.length) return;

    // Check for ingrown hair first for plucking
    for (const intersect of intersects) {
        let object = intersect.object;
        // Ascend the hierarchy to find the group
        while(object.parent && !object.userData.isIngrownHair) {
            object = object.parent;
        }

        if (object.userData.isIngrownHair) {
            controls.enabled = false; // Disable camera controls during pluck

            // Create the visible hair mesh
            const hairGeometry = new THREE.CylinderGeometry(0.003, 0.003, 1, 6); // Use length 1 for easy scaling
            hairGeometry.translate(0, 0.5, 0); // Anchor at the bottom
            const hairMaterial = new THREE.MeshBasicMaterial({ color: 0x24170d });
            const hairMesh = new THREE.Mesh(hairGeometry, hairMaterial);
            
            // Get base position and orientation from the hair "mound"
            const hairBasePosition = new THREE.Vector3();
            object.getWorldPosition(hairBasePosition);
            hairMesh.position.copy(hairBasePosition);

            // Set initial scale to almost 0 to hide it
            hairMesh.scale.set(1, 0.001, 1);
            scene.add(hairMesh);

            // Create a plane for raycasting, facing the camera, at the hair's origin
            const planeNormal = camera.position.clone().sub(hairBasePosition).normalize();
            const dragPlane = new THREE.Plane(planeNormal, -hairBasePosition.dot(planeNormal));
            
            currentPluckingAction = {
                hairGroup: object,
                hairMesh: hairMesh,
                dragPlane: dragPlane,
                startScreenPos: new THREE.Vector2(event.clientX, event.clientY),
            };
            return;
        }
    }
}

function onPointerMove(event) {
    if (!currentPluckingAction) return;

    const { hairMesh, dragPlane, hairGroup, startScreenPos } = currentPluckingAction;

    // Get the current cursor position in normalized device coordinates
    const gameRect = gameArea.getBoundingClientRect();
    mouse.x = ((event.clientX - gameRect.left) / gameRect.width) * 2 - 1;
    mouse.y = -((event.clientY - gameRect.top) / gameRect.height) * 2 + 1;

    // Raycast from camera to the drag plane to find the 3D cursor position
    raycaster.setFromCamera(mouse, camera);
    const cursorPoint3D = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, cursorPoint3D);

    if (cursorPoint3D) {
        // Vector from hair base to the cursor's 3D position
        const pullVector = cursorPoint3D.clone().sub(hairMesh.position);
        const pullDistance = pullVector.length();

        // Update hair length and orientation
        hairMesh.scale.y = pullDistance;
        hairMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pullVector.normalize());
        
        // Check if the 2D drag distance has exceeded the threshold
        const currentScreenPos = new THREE.Vector2(event.clientX, event.clientY);
        const screenDragDistance = currentScreenPos.distanceTo(startScreenPos);

        if (screenDragDistance > PULL_THRESHOLD) {
            pluckHair(hairGroup, hairMesh);
            currentPluckingAction = null; // Stop further updates
        }
    }
}

function onPointerUp(event) {
    if (currentPluckingAction) {
        // If pointer is released before threshold, the hair wasn't plucked
        scene.remove(currentPluckingAction.hairMesh);
        currentPluckingAction = null;
        // Don't re-enable controls immediately, wait for the next mousedown
        // This prevents the camera from jumping after a failed pluck.
    } else {
        // Re-enable controls if no plucking action was in progress.
        controls.enabled = true;
        
        // If not plucking, handle pimple popping on click (pointerup without move)
        if (controls.isDragging) return;
        
        // This logic helps differentiate a click from the end of a drag.
        if (event.pointerType === 'mouse' && event.buttons !== 0) {
           // This is likely a drag end, not a click, do nothing.
        } else {
             const intersects = getIntersects(event.clientX, event.clientY);
             for (const intersect of intersects) {
                if (intersect.object.userData.isPimple && !intersect.object.userData.popped) {
                    popPimple(intersect.object);
                    break; 
                }
            }
        }
    }
}

function getIntersects(x, y) {
    const gameRect = gameArea.getBoundingClientRect();
    mouse.x = ((x - gameRect.left) / gameRect.width) * 2 - 1;
    mouse.y = -((y - gameRect.top) / gameRect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    return raycaster.intersectObjects(scene.children, true);
}

function pluckHair(hairGroup, hairMesh) {
    playPluckSound();
    score += 2; // More points for more effort!
    scoreEl.textContent = score;

    // Confetti from the plucking spot
    const screenPos = toScreenPositionForConfetti(hairMesh, camera);
    confetti({
        particleCount: 50,
        spread: 90,
        startVelocity: 30,
        origin: { x: screenPos.x, y: screenPos.y },
        colors: ['#333333', '#666666', '#FFFFFF'],
        shapes: ['square']
    });

    // Remove the visual hair spot from the face
    faceMesh.remove(hairGroup);
    const index = ingrownHairs.indexOf(hairGroup);
    if (index > -1) ingrownHairs.splice(index, 1);

    // Animate the pulled hair flying off screen
    const flyAway = () => {
        hairMesh.position.x += (Math.random() - 0.5) * 0.1;
        hairMesh.position.y += Math.random() * 0.05 + 0.05;
        hairMesh.position.z += (Math.random() - 0.5) * 0.1;
        hairMesh.rotation.x += 0.2;
        hairMesh.rotation.z += 0.2;
        if (hairMesh.material.opacity > 0) {
            hairMesh.material.opacity -= 0.02;
            requestAnimationFrame(flyAway);
        } else {
            scene.remove(hairMesh);
        }
    };
    hairMesh.material.transparent = true;
    hairMesh.material.opacity = 1.0;
    flyAway();
}

function popPimple(pimpleMesh) {
    if (pimpleMesh.userData.popped) return;

    playPopSound();
    
    pimpleMesh.userData.popped = true;

    score++;
    scoreEl.textContent = score;

    // Confetti
    const screenPos = toScreenPositionForConfetti(pimpleMesh, camera);
    confetti({
        particleCount: Math.floor(Math.random() * 20 + 30),
        spread: 70,
        angle: Math.random() * 360,
        startVelocity: 25,
        origin: { x: screenPos.x, y: screenPos.y },
        colors: ['#FFFF00', '#FFFACD', '#FAFAD2', '#FFFFFF'],
        scalar: Math.random() * 0.5 + 0.75
    });

    // Animate pop
    pimpleMesh.material.color.set(0x5a2d2d);
    pimpleMesh.material.transparent = true;
    let opacity = 1;
    const fade = () => {
        opacity -= 0.05;
        if (opacity <= 0) {
            faceMesh.remove(pimpleMesh);
            const index = pimples.indexOf(pimpleMesh);
            if (index > -1) pimples.splice(index, 1);
        } else {
            pimpleMesh.material.opacity = opacity;
            requestAnimationFrame(fade);
        }
    };
    setTimeout(fade, 100);
}

function toScreenPositionForConfetti(obj, camera) {
    const vector = new THREE.Vector3();
    const gameRect = gameArea.getBoundingClientRect();

    obj.getWorldPosition(vector);
    vector.project(camera);

    vector.x = (vector.x * 0.5 + 0.5) * gameRect.width + gameRect.left;
    vector.y = (vector.y * -0.5 + 0.5) * gameRect.height + gameRect.top;

    return {
        x: vector.x / window.innerWidth,
        y: vector.y / window.innerHeight
    };
}

// Helper to convert world coordinates to screen coordinates (within gameArea)
function worldToScreen(worldVector, camera, element) {
    const projectedVector = worldVector.clone().project(camera);
    const rect = element.getBoundingClientRect();
    const screenVector = new THREE.Vector2();
    screenVector.x = rect.left + ((projectedVector.x + 1) / 2) * rect.width;
    screenVector.y = rect.top + ((-projectedVector.y + 1) / 2) * rect.height;
    return screenVector;
}

// --- Game Initialization ---
function startGame() {
    // Initial audio setup requires user interaction
    document.body.addEventListener('pointerdown', initializeAudio, { once: true });
    
    score = 0;
    scoreEl.textContent = score;
    
    // Clear any previous objects
    pimples.forEach(p => faceMesh.remove(p));
    pimples.length = 0;
    ingrownHairs.forEach(h => faceMesh.remove(h));
    ingrownHairs.length = 0;

    // Initial burst of pimples
    for(let i=0; i<8; i++) { createPimple(); }
    for(let i=0; i<4; i++) { createIngrownHair(); }
    
    // Spawn pimples at random intervals
    function spawnLoop() {
        if (Math.random() > 0.4) { // 60% chance to spawn a pimple
             createPimple();
        } else { // 40% chance to spawn a hair
            createIngrownHair();
        }
        const nextSpawnTime = Math.random() * 1200 + 400; // between 0.4s and 1.6s
        setTimeout(spawnLoop, nextSpawnTime);
    }
    
    spawnLoop();
}

function animate() {
    requestAnimationFrame(animate);
    if(controls && controls.enabled) controls.update(); // only update controls if they are enabled
    renderer.render(scene, camera);
}

init3D();
animate();