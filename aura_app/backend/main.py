from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn
import asyncio
import json
from contextlib import asynccontextmanager
from anyio import CancelScope
from brain import AuraBrain
from bailian import SpeechError

brain = AuraBrain()
preview_lock = asyncio.Lock()


@asynccontextmanager
async def camera_preview(camera):
    preview = camera.preview()
    async with preview_lock:
        preview.__enter__()
    try:
        yield
    finally:
        # Stream disconnect cancellation must not interrupt device/model cleanup.
        with CancelScope(shield=True):
            async with preview_lock:
                await asyncio.to_thread(preview.__exit__, None, None, None)


@asynccontextmanager
async def lifespan(app):
    brain.sound_direction.start()
    try:
        yield
    finally:
        brain.voice.stop()
        await asyncio.to_thread(brain.sound_direction.stop)
        if brain.camera_manager is not None:
            await asyncio.to_thread(brain.camera_manager.stop)


app = FastAPI(title="Desktop Companion Assistant", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {
        "status": "online",
        "system": "Desktop Companion Assistant",
        "version": "2.0.0"
    }

@app.get("/video_feed")
async def video_feed():
    """
    Real-Time Motion & Perception AR Camera Stream for Frontend HUD.
    """
    if brain.camera_manager is None:
        raise HTTPException(status_code=503, detail="Gesture camera is unavailable")
    camera = brain.camera_manager

    async def frame_generator():
        async with camera_preview(camera):
            while True:
                error = camera.get_telemetry()["perception_error"]
                if error:
                    raise RuntimeError(f"Camera preview failed: {error}")
                jpeg_bytes = camera.get_frame_jpeg()
                if jpeg_bytes:
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + jpeg_bytes + b'\r\n')
                await asyncio.sleep(1 / 15)

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[WebSocket] Client connected to AURA Brain.")

    # High-Frequency Real-Time Telemetry Background Task
    async def stream_telemetry():
        try:
            while True:
                telemetry = brain.get_realtime_telemetry()
                await websocket.send_json(telemetry)
                await asyncio.sleep(0.02 if telemetry["audio"]["is_speaking"] else 0.1)
        except WebSocketDisconnect:
            return
        except Exception as error:
            print(f"[Telemetry Error] {error}")

    telemetry_task = asyncio.create_task(stream_telemetry())
    command_tasks = set()

    async def process_command(data):
        try:
            try:
                if data == "START_CONTINUOUS":
                    response = await brain.process_message(data, on_turn=websocket.send_json)
                else:
                    response = await brain.process_message(data)
            except SpeechError as error:
                print(f"[AURA] {error}")
                response = {
                    "type": "response", "text": str(error), "system": True,
                    "mood": brain.mood, "action": None,
                }
            except Exception as error:
                print(f"[AURA Command Error] {type(error).__name__}: {error}")
                response = {
                    "type": "response", "text": "处理请求失败，请检查后端日志。", "system": True,
                    "mood": brain.mood, "action": None,
                }
            if response:
                await websocket.send_json(response)
        except (WebSocketDisconnect, RuntimeError) as error:
            print(f"[WebSocket Command Error] {error}")

    try:
        while True:
            data = await websocket.receive_text()
            print(f"[WebSocket Received] {data}")

            # Keep receiving controls while the current turn awaits LLM/TTS/playback.
            if data in ("STOP_SPEECH", "STOP_CONTINUOUS"):
                await process_command(data)
            else:
                task = asyncio.create_task(process_command(data))
                command_tasks.add(task)
                task.add_done_callback(command_tasks.discard)
                # Register the turn before handling an immediately queued stop command.
                await asyncio.sleep(0)
    except WebSocketDisconnect:
        print("[WebSocket] Client disconnected.")
    except Exception as e:
        print(f"[WebSocket Error] {e}")
    finally:
        telemetry_task.cancel()
        for task in command_tasks:
            if not task.cancelling():
                task.cancel()
        await asyncio.gather(telemetry_task, *command_tasks, return_exceptions=True)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
