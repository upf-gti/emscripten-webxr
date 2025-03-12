var LibraryWebXR = {

$WebXR: {
    refSpaces: {},
    _curRAF: null,
    // WebXR/WebGPU interop globals.
    xrGpuBinding: null,
    projectionLayer: null,
    gpuDevice: null,

    WEBXR_ERR_WEBXR_UNSUPPORTED: -2,
    WEBXR_ERR_WEBGPU_UNSUPPORTED: -3,
    WEBXR_ERR_XRGPU_BINDING_UNSUPPORTED: -4,
    WEBXR_ERR_IMMERSIVE_XR_UNSUPPORTED: -5,

    _nativize_vec3: function(offset, vec) {
        setValue(offset + 0, vec.x, 'float');
        setValue(offset + 4, vec.y, 'float');
        setValue(offset + 8, vec.z, 'float');

        return offset + 12;
    },

    _nativize_vec4: function(offset, vec) {
        WebXR._nativize_vec3(offset, vec);
        setValue(offset + 12, vec.w, 'float');

        return offset + 16;
    },

    _nativize_matrix: function(offset, mat) {
        for (var i = 0; i < 16; ++i) {
            setValue(offset + i*4, mat[i], 'float');
        }

        return offset + 16*4;
    },

    _nativize_rigid_transform: function(offset, t) {
        offset = WebXR._nativize_matrix(offset, t.inverse.matrix);
        offset = WebXR._nativize_vec3(offset, t.position);
        offset = WebXR._nativize_vec4(offset, t.orientation);

        return offset;
    },

    /* Sets input source values to offset and returns pointer after struct */
    _nativize_input_source: function(offset, inputSource, id) {
        var handedness = -1;
        if(inputSource.handedness == "left") handedness = 0;
        else if(inputSource.handedness == "right") handedness = 1;

        var targetRayMode = 0;
        if(inputSource.targetRayMode == "tracked-pointer") targetRayMode = 1;
        else if(inputSource.targetRayMode == "screen") targetRayMode = 2;

        setValue(offset, id, 'i32');
        offset +=4;
        setValue(offset, handedness, 'i32');
        offset +=4;
        setValue(offset, targetRayMode, 'i32');
        offset +=4;

        return offset;
    },

    _set_input_callback__deps: ['$dynCall'],
    _set_input_callback: function(event, callback, userData) {
        var s = Module['webxr_session'];
        if(!s) return;
        if(!callback) return;

        s.addEventListener(event, function(e) {
            /* Nativize input source */
            var inputSource = Module._malloc(8); /* 2*sizeof(int32) */
            WebXR._nativize_input_source(inputSource, e.inputSource, i);

            /* Call native callback */
            dynCall('vii', callback, [inputSource, userData]);

            _free(inputSource);
        });
    },

    _set_session_callback__deps: ['$dynCall'],
    _set_session_callback: function(event, callback, userData) {
        var s = Module['webxr_session'];
        if(!s) return;
        if(!callback) return;

        s.addEventListener(event, function() {
            dynCall('vi', callback, [userData]);
        });
    },

    _print_error: function(error, error_code, on_error) {
        console.error( error );
        /* Call error callback */
        on_error(error_code);
        // const msg = document.createElement("div");
        // Object.assign( msg.style, {
        //     width: "50%",
        //     fontSize: "36px",
        //     fontWeight: "500",
        //     textAlign: "center",
        //     margin: "0 auto",
        //     marginTop: "25%"
        // } );
        // msg.innerText = error;
        // document.body.appendChild(msg);
    }
},

webxr_set_device: async function(gpuDevice) {
    WebXR.gpuDevice = WebGPU.getJsObject(gpuDevice);
},

webxr_init__deps: ['$dynCall'],
webxr_init: async function(frameCallback, initWebXRCallback, startSessionCallback, endSessionCallback, errorCallback, userData) {

    function onInitWebXR() {
        if(!initWebXRCallback) return;
        dynCall('vi', initWebXRCallback, [userData]);    
    };

    function onError(errorCode) {
        if(!errorCallback) return;
        dynCall('vii', errorCallback, [userData, errorCode]);
    };

    function onSessionEnd(mode) {
        if(!endSessionCallback) return;
        mode = {'inline': 0, 'immersive-vr': 1, 'immersive-ar': 2}[mode];
        dynCall('vii', endSessionCallback, [userData, mode]);
    };

    function onSessionStart(mode) {
        if(!startSessionCallback) return;
        mode = {'inline': 0, 'immersive-vr': 1, 'immersive-ar': 2}[mode];
        dynCall('vii', startSessionCallback, [userData, mode]);
    };

    const SIZE_OF_WEBXR_VIEW = (16 + 3 + 4 + 16 + 4)*4;
    const views = Module._malloc(SIZE_OF_WEBXR_VIEW*2 + (16 + 4 + 3)*4);
    let texture_views = [];

    function onFrame(time, frame) {

        if(!frameCallback) return;
        /* Request next frame */
        const session = frame.session;
        /* RAF is set to null on session end to avoid rendering */

        if(Module['webxr_session'] != null) session.requestAnimationFrame(onFrame);

        // Getting the pose may fail if, for example, tracking is lost. So we
        // have to check to make sure that we got a valid pose before attempting
        // to render with it. If not in this case we'll just leave the
        // framebuffer cleared, so tracking loss means the scene will simply
        // disappear.
        const pose = frame.getViewerPose(WebXR.refSpace);
        if(!pose) return;

        pose.views.forEach(function(view) {
            let subImage = WebXR.xrGpuBinding.getViewSubImage(WebXR.projectionLayer, view);
            let viewport = subImage.viewport;

            let idx = (view.eye == 'right' ? 1 : 0)

            let texture_view = subImage.colorTexture.createView(subImage.getViewDescriptor())
            texture_views[idx] = WebGPU.importJsTextureView(texture_view)

            let offset = views + SIZE_OF_WEBXR_VIEW*idx;
            offset = WebXR._nativize_rigid_transform(offset, view.transform);
            offset = WebXR._nativize_matrix(offset, view.projectionMatrix);

            setValue(offset + 0, viewport.x, 'i32');
            setValue(offset + 4, viewport.y, 'i32');
            setValue(offset + 8, viewport.width, 'i32');
            setValue(offset + 12, viewport.height, 'i32');
        });

        /* Model matrix */
        const modelMatrix = views + SIZE_OF_WEBXR_VIEW*2;
        WebXR._nativize_matrix(modelMatrix, pose.transform.matrix);

        /* Set and reset environment for webxr_get_input_pose calls */
        Module['webxr_frame'] = frame;
        dynCall('viiiiiii', frameCallback, [userData, time, modelMatrix, views, texture_views[0], texture_views[1], pose.views.length]);
        Module['webxr_frame'] = null;
    };

    async function onSessionStarted(session, mode) {
        Module['webxr_session'] = session;

        // Listen for the sessions 'end' event so we can respond if the user
        // or UA ends the session for any reason.
        session.addEventListener('end', async function() {
            Module['webxr_session'].cancelAnimationFrame(WebXR._curRAF);
            Module['webxr_session'] = null;
            WebXR._curRAF = null;
            WebXR.xrGpuBinding = null;
            onSessionEnd(mode);
        });

        if (!WebXR.gpuDevice) {
            console.error("No GPU Device, please call webxr_set_device(device).");
        }

        // Create the WebXR/WebGPU binding, and with it create a projection layer to render to.
        WebXR.xrGpuBinding = new XRGPUBinding(session, WebXR.gpuDevice);

        const colorFormat = navigator.gpu.getPreferredCanvasFormat();

        WebXR.projectionLayer = WebXR.xrGpuBinding.createProjectionLayer({
            colorFormat
        });

        // Set the session's layers to display the projection layer. This allows
        // any content rendered to the layer to be displayed on the XR device.
        session.updateRenderState({ layers: [WebXR.projectionLayer] });

        // Get a reference space, which is required for querying poses. In this
        // case an 'local' reference space means that all poses will be relative
        // to the location where the XR device was first detected.
        session.requestReferenceSpace('local').then((refSpace) => {
            // WebXR.refSpaces['local'] = refSpace;
            WebXR.refSpace = refSpace;

            // Give application a chance to react to session starting
            // e.g. finish current desktop frame.
            onSessionStart(mode);

            // Inform the session that we're ready to begin drawing.
            session.requestAnimationFrame(onFrame);
        });

        // /* Request and cache other available spaces, which may not be available */
        // for(const s of ['viewer', 'local-floor', 'bounded-floor', 'unbounded']) {
        //     session.requestReferenceSpace(s).then(refSpace => {
        //         /* We prefer the reference space automatically in above order */
        //         WebXR.refSpace = s;

        //         WebXR.refSpaces[s] = refSpace;
        //     }, function() { /* Leave refSpaces[s] unset. */ })
        // }
    };

    let xrButton = document.getElementById('xr-button');

    if (!navigator.xr) {
        const error_msg = "WebXR is not supported by your browser.";
        xrButton.textContent = error_msg;
        WebXR._print_error(error_msg, WebXR.WEBXR_ERR_API_UNSUPPORTED, onError);
        return;
    }

    // If there's not WebGPU it won't load the engine, so this is unnecessary..
    if (!navigator.gpu) {
        const error_msg = "WebGPU is not supported by your browser.";
        xrButton.textContent = error_msg;
        WebXR._print_error(error_msg, WebXR.WEBXR_ERR_WEBGPU_UNSUPPORTED, onError);
        return;
    }

    if (!('XRGPUBinding' in window)) {
        const error_msg = "WebXR/WebGPU interop is not supported by your browser.";
        xrButton.textContent = error_msg;
        WebXR._print_error(error_msg, WebXR.WEBXR_ERR_XRGPU_BINDING_UNSUPPORTED, onError);
        return;
    }

    // If the UA allows creation of immersive VR sessions enable the
    // target of the 'Enter XR' button.
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    if (!supported) {
        const error_msg = "Immersive VR not supported.";
        xrButton.textContent = error_msg;
        WebXR._print_error(error_msg, WebXR.WEBXR_ERR_IMMERSIVE_XR_UNSUPPORTED, onError);
        return;
    }

    // Reaching this means it's all supported!

    xrButton.addEventListener('click', function() {
        Module["webxr_request_session_func"]('immersive-vr', ['webgpu'])
    });

    xrButton.textContent = 'Enter VR';
    xrButton.disabled = false;

    Module['webxr_request_session_func'] = function(mode, requiredFeatures, optionalFeatures) {

        if(typeof(mode) !== 'string') {
            mode = (['inline', 'immersive-vr', 'immersive-ar'])[mode];
        }

        let toFeatureList = function(bitMask) {
            const f = [];
            const features = ['local', 'local-floor', 'bounded-floor', 'unbounded', 'hit-test', 'webgpu'];
            for(let i = 0; i < features.length; ++i) {
                if((bitMask & (1 << i)) != 0) {
                    f.push(features[i]);
                }
            }
            return f;
        };
        if(typeof(requiredFeatures) === 'number') {
            requiredFeatures = toFeatureList(requiredFeatures);
        }
        if(typeof(optionalFeatures) === 'number') {
            optionalFeatures = toFeatureList(optionalFeatures);
        }

        navigator.xr.requestSession(mode, {
            requiredFeatures: requiredFeatures,
            optionalFeatures: optionalFeatures
        }).then(function(s) {
            onSessionStarted(s, mode);
        }).catch(console.error);
    };

    onInitWebXR();
},

webxr_is_session_supported__deps: ['$dynCall'],
webxr_is_session_supported: function(mode, callback) {
    if (!navigator.xr || !navigator.gpu || !('XRGPUBinding' in window) ) {
        dynCall('vii', callback, [mode, 0]);
        return;
    }
    navigator.xr.isSessionSupported((['inline', 'immersive-vr', 'immersive-ar'])[mode]).then(function() {
        dynCall('vii', callback, [mode, 1]);
    }, function() {
        dynCall('vii', callback, [mode, 0]);
    });
},

webxr_request_session: function(mode, requiredFeatures) {
    var s = Module['webxr_request_session_func'];
    if(s) s(mode, requiredFeatures);
},

webxr_request_exit: function() {
    var s = Module['webxr_session'];
    if(s) Module['webxr_session'].end();
},

webxr_set_projection_params: function(near, far) {
    var s = Module['webxr_session'];
    if(!s) return;

    s.depthNear = near;
    s.depthFar = far;
},

webxr_set_session_blur_callback: function(callback, userData) {
    WebXR._set_session_callback("blur", callback, userData);
},

webxr_set_session_focus_callback: function(callback, userData) {
    WebXR._set_session_callback("focus", callback, userData);
},

webxr_set_select_callback: function(callback, userData) {
    WebXR._set_input_callback("select", callback, userData);
},
webxr_set_select_start_callback: function(callback, userData) {
    WebXR._set_input_callback("selectstart", callback, userData);
},
webxr_set_select_end_callback: function(callback, userData) {
    WebXR._set_input_callback("selectend", callback, userData);
},

webxr_get_input_sources: function(outArrayPtr, max, outCountPtr) {
    let s = Module['webxr_session'];
    if(!s) return; // TODO(squareys) warning or return error

    let i = 0;
    // this sorts the array so end up breaking the LEFT=0, RIGHT=1 distinction
    // for (let inputSource of s.inputSources) {
    for (; i < s.inputSources.length; ++i) {
        if(i >= max) break;
        let inputSource = s.inputSources[i];
        outArrayPtr = WebXR._nativize_input_source(outArrayPtr, inputSource, i);
    }
    setValue(outCountPtr, i, 'i32');
},

webxr_get_input_pose: function(source, outPosePtr, space) {
    let f = Module['webxr_frame'];
    if(!f) {
        console.warn("Cannot call webxr_get_input_pose outside of frame callback");
        return false;
    }

    const id = getValue(source, 'i32');
    const input = Module['webxr_session'].inputSources[id];

    const s = space == 0 ? input.gripSpace : input.targetRaySpace;
    if(!s) return false;
    const pose = f.getPose(s, WebXR.refSpace);

    if(!pose || Number.isNaN(pose.transform.matrix[0])) return false;

    WebXR._nativize_rigid_transform(outPosePtr, pose.transform);

    return true;
},

webxr_get_input_button: function(source, buttonId, outButtonPtr) {
    let f = Module['webxr_frame'];
    if(!f) {
        console.warn("Cannot call webxr_get_input_buttons outside of frame callback");
        return false;
    }

    const id = getValue(source, 'i32');
    const input = Module['webxr_session'].inputSources[id];

    const button = input.gamepad.buttons[buttonId];

    //  nativize gamepad button
    setValue(outButtonPtr, button.pressed, 'i8');
    outButtonPtr +=1;
    setValue(outButtonPtr, button.touched, 'i8');
    outButtonPtr +=1;
    setValue(outButtonPtr, button.value, 'float');
    outButtonPtr +=4;

    return true;
},

// webxr_get_input_buttons: function(source, outButtonsPtr) {
//     let f = Module['webxr_frame'];
//     if(!f) {
//         console.warn("Cannot call webxr_get_input_buttons outside of frame callback");
//         return false;
//     }

//     const id = getValue(source, 'i32');
//     const input = Module['webxr_session'].inputSources[id];

//     for(let i = 0; i < input.gamepad.buttons.length; ++i) {
//         outButtonsPtr[i].value = input.gamepad.buttons[i].value;
//     }

//     return true;
// },

};

autoAddDeps(LibraryWebXR, '$WebXR');
mergeInto(LibraryManager.library, LibraryWebXR);
