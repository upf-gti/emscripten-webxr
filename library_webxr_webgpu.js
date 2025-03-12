var LibraryWebXR = {

$WebXR: {
    refSpaces: {},
    _curRAF: null,
    // WebXR/WebGPU interop globals.
    xrGpuBinding: null,
    projectionLayer: null,
    gpuDevice: null,

    WEBXR_ERR_WEBXR_UNSUPPORTED: -2, /**< WebXR Device API not supported in this browser */
    WEBXR_ERR_WEBGPU_UNSUPPORTED: -3, /**< WebXR Device API not supported in this browser */
    WEBXR_ERR_XRGPU_BINDING_UNSUPPORTED: -4, /**< given session mode not supported */

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
        /*
        In C++, the method is like this one:
            [](void* userData, int, float[16], WebXRView* views) {
                static_cast<WebXrExample*>(userData)->drawWebXRFrame(views);
            }
        */

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

        // Ensure our context can handle WebXR rendering
        // Module.ctx.makeXRCompatible().then(async function() {
            
        // Create a WebGPU adapter and device to render with, initialized to be
        // compatible with the XRDisplay we're presenting to. Note that a canvas
        // is not necessary if we are only rendering to the XR device.
        // const adapter = await navigator.gpu.requestAdapter({
        //     xrCompatible: true
        // });
        // const gpuDevice = await adapter.requestDevice();

        if (!WebXR.gpuDevice) {
            console.error("No GPU Device, please call webxr_set_device(device)");
        }

        // Create the WebXR/WebGPU binding, and with it create a projection
        // layer to render to.
        WebXR.xrGpuBinding = new XRGPUBinding(session, WebXR.gpuDevice);

        // If the preferred color format doesn't match what we've been rendering
        // with so far, rebuild the pipeline
        // if (colorFormat != xrGpuBinding.getPreferredColorFormat()) {
        //     colorFormat = xrGpuBinding.getPreferredColorFormat();
        //     await initWebGPU();
        // }
        const colorFormat = navigator.gpu.getPreferredCanvasFormat();
        // const depthStencilFormat = 'depth24plus';

        WebXR.projectionLayer = WebXR.xrGpuBinding.createProjectionLayer({
            colorFormat
            // depthStencilFormat,
        });

        // Set the session's layers to display the projection layer. This allows
        // any content rendered to the layer to be displayed on the XR device.
        session.updateRenderState({ layers: [WebXR.projectionLayer] });

        // Get a reference space, which is required for querying poses. In this
        // case an 'local' reference space means that all poses will be relative
        // to the location where the XR device was first detected.
        session.requestReferenceSpace('local').then((refSpace) => {
            //WebXR.refSpaces['local'] = refSpace;
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
            
        // }, function() {
        //     onError(WebXR.WEBXR_ERR_GL_INCAPABLE);
        // });
    };

    let error = "";
    let error_code = 0;

    if (!navigator.xr) {
        error = "Sorry, WebXR is not supported by your browser.";
        error_code = WebXR.WEBXR_ERR_API_UNSUPPORTED;
    }
    else if (!navigator.gpu) {
        error = "Sorry, WebGPU is not supported by your browser.";
        error_code = WebXR.WEBXR_ERR_WEBGPU_UNSUPPORTED;
    }
    else if (!('XRGPUBinding' in window)) {
        error = "Sorry, WebXR/WebGPU interop is not supported by your browser.";
        error_code = WebXR.WEBXR_ERR_XRGPU_BINDING_UNSUPPORTED;
    }

    // If the UA allows creation of immersive VR sessions enable the
    // target of the 'Enter XR' button.
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    if (!supported) {
        error = 'Sorry, Immersive VR not supported.';
    }

    let xrButton = document.getElementById('xr-button');

    xrButton.addEventListener('click', function() {
        Module["webxr_request_session_func"]('immersive-vr', ['webgpu'])
    });

    xrButton.textContent = 'Enter VR';
    xrButton.disabled = false;

    if(error.length == 0) {

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

    } else {

        console.error( error );
        const msg = document.createElement("div");
        Object.assign( msg.style, {
            width: "50%",
            fontSize: "36px",
            fontWeight: "500",
            textAlign: "center",
            margin: "0 auto",
            marginTop: "25%"
        } );
        msg.innerText = error;
        document.body.appendChild(msg);
        /* Call error callback */
        onError(error_code);
    }
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
    for (let inputSource of s.inputSources) {
        if(i >= max) break;
        outArrayPtr = WebXR._nativize_input_source(outArrayPtr, inputSource, i);
        ++i;
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
    const pose = f.getPose(s, WebXR.refSpaces[WebXR.refSpace]);

    if(!pose || Number.isNaN(pose.transform.matrix[0])) return false;

    WebXR._nativize_rigid_transform(outPosePtr, pose.transform);

    return true;
},

};

autoAddDeps(LibraryWebXR, '$WebXR');
mergeInto(LibraryManager.library, LibraryWebXR);
