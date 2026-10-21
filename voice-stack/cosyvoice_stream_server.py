"""A localhost FastAPI adapter for CosyVoice streaming SFT inference.

Install and run this script from a CosyVoice checkout. Muse consumes raw mono
PCM chunks from /stream/inference_sft and never sends speech audio to a cloud
recognition or synthesis service.
"""

import argparse
import os
import sys
from threading import Lock

import numpy as np
import torch
from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import StreamingResponse
import uvicorn


parser = argparse.ArgumentParser()
parser.add_argument("--model-dir", default=os.getenv("COSYVOICE_MODEL_DIR", "pretrained_models/CosyVoice-300M-SFT"))
parser.add_argument("--host", default=os.getenv("COSYVOICE_HOST", "127.0.0.1"))
parser.add_argument("--port", type=int, default=int(os.getenv("COSYVOICE_PORT", "50000")))
args = parser.parse_args()

cosyvoice_root = os.path.abspath(os.getenv("COSYVOICE_ROOT", os.getcwd()))
if not os.path.isfile(os.path.join(cosyvoice_root, "cosyvoice", "cli", "cosyvoice.py")):
    raise SystemExit("Run this script from the CosyVoice repository root, or set COSYVOICE_ROOT to that directory.")
sys.path.insert(0, cosyvoice_root)
sys.path.insert(0, os.path.join(cosyvoice_root, "third_party", "Matcha-TTS"))

from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402


print(f"Loading CosyVoice model: {args.model_dir}", flush=True)
model = AutoModel(model_dir=args.model_dir)
speaker_ids = model.list_available_spks()
inference_lock = Lock()
app = FastAPI(title="Muse CosyVoice Local Stream")


@app.get("/health")
def health():
    return {
        "ready": True,
        "engine": "CosyVoice",
        "sample_rate": int(model.sample_rate),
        "speakers": speaker_ids,
    }


@app.post("/stream/inference_sft")
def inference_sft(tts_text: str = Form(), spk_id: str = Form()):
    text = tts_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="tts_text is required")
    if len(text) > 3000:
        raise HTTPException(status_code=413, detail="tts_text exceeds 3000 characters")
    if speaker_ids and spk_id not in speaker_ids:
        raise HTTPException(status_code=400, detail=f"Unknown speaker. Available speakers: {', '.join(speaker_ids)}")

    def audio_chunks():
        # Keep one local model inference active at a time to bound 16 GB memory use.
        with inference_lock:
            for item in model.inference_sft(text, spk_id, stream=True):
                audio = item["tts_speech"].detach().cpu().numpy().reshape(-1)
                audio = np.clip(audio, -1.0, 1.0)
                yield (audio * 32767).astype("<i2", copy=False).tobytes()

    return StreamingResponse(audio_chunks(), media_type="application/octet-stream", headers={
        "X-Custom-Header-sampleRate": str(int(model.sample_rate)),
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
    })


if __name__ == "__main__":
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
