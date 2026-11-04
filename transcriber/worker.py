#!/usr/bin/env python3
"""Worker de transcription nominative.

Chaque participant enregistre son propre micro depuis la page de réunion.
Le worker transcrit chaque piste séparément (faster-whisper, français),
assemble les segments par horodatage et les attribue au bon locuteur.
Aucun service externe n'est appelé à l'exécution ; le modèle est téléchargé
une fois puis mis en cache dans le volume /models.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
import requests
from botocore.config import Config as BotoConfig

API_URL = os.environ.get("API_INTERNAL_URL", "http://api:3080").rstrip("/")
API_KEY = os.environ.get("MASTER_API_KEY", "")
CAPTURES_DIR = Path(os.environ.get("CAPTURES_DIR", "/captures")).resolve()
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "fr")
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
POLL_SECONDS = int(os.environ.get("WORKER_POLL_SECONDS", "10"))

S3_ENDPOINT = os.environ["S3_ENDPOINT"]
S3_BUCKET = os.environ.get("S3_BUCKET", "prototype-meet")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_ACCESS_KEY = os.environ["S3_ACCESS_KEY"]
S3_SECRET_KEY = os.environ["S3_SECRET_KEY"]

SESSION = requests.Session()
SESSION.headers.update({"x-api-key": API_KEY, "content-type": "application/json"})

S3 = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT,
    region_name=S3_REGION,
    aws_access_key_id=S3_ACCESS_KEY,
    aws_secret_access_key=S3_SECRET_KEY,
    config=BotoConfig(
        signature_version="s3v4",
        s3={"addressing_style": "path"},
        retries={"max_attempts": 4, "mode": "standard"},
    ),
)

_MODEL = None


def log(message: str) -> None:
    print(f"[transcriber] {message}", flush=True)


def model():
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel

        log(f"chargement du modèle {MODEL_NAME} ({DEVICE}/{COMPUTE_TYPE})")
        _MODEL = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _MODEL


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def hhmmss(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def srt_time(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    return f"{ms // 3600000:02d}:{(ms % 3600000) // 60000:02d}:{(ms % 60000) // 1000:02d},{ms % 1000:03d}"


def vtt_time(seconds: float) -> str:
    return srt_time(seconds).replace(",", ".")


def is_muted(start: float, end: float, intervals: list[dict[str, Any]]) -> bool:
    midpoint = (start + end) / 2
    for interval in intervals:
        try:
            low = float(interval.get("start", 0))
            high = float(interval.get("end", 0))
        except (TypeError, ValueError):
            continue
        if low <= midpoint <= high:
            return True
    return False


def ensure_wav(path: Path) -> Path:
    """Remux défensif des chunks MediaRecorder en WAV mono 16 kHz."""
    handle, name = tempfile.mkstemp(suffix=".wav")
    os.close(handle)
    output = Path(name)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
         "-ar", "16000", "-ac", "1", str(output)],
        check=True,
        timeout=1800,
    )
    return output


def transcribe_capture(meeting: dict[str, Any], capture: dict[str, Any]) -> list[dict[str, Any]]:
    relative = Path(capture["file_path"])
    path = (CAPTURES_DIR / relative).resolve()
    if CAPTURES_DIR not in path.parents:
        raise RuntimeError("Chemin de capture hors du répertoire autorisé")
    if not path.exists() or path.stat().st_size == 0:
        log(f"capture absente ou vide: {path}")
        return []

    capture_start = parse_iso(capture["started_at"])
    meeting_start = parse_iso(meeting["starts_at"])
    intervals = capture.get("mute_intervals") or []
    audio_path = path
    temp_wav = None
    try:
        try:
            segments, _info = model().transcribe(
                str(audio_path),
                language=LANGUAGE,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 450},
                condition_on_previous_text=False,
            )
            raw_segments = list(segments)
        except Exception as first_error:
            log(f"décodage direct impossible ({first_error}), conversion ffmpeg")
            temp_wav = ensure_wav(path)
            segments, _info = model().transcribe(
                str(temp_wav),
                language=LANGUAGE,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 450},
                condition_on_previous_text=False,
            )
            raw_segments = list(segments)
    finally:
        if temp_wav and temp_wav.exists():
            temp_wav.unlink(missing_ok=True)

    result = []
    for segment in raw_segments:
        text = segment.text.strip()
        if not text or is_muted(segment.start, segment.end, intervals):
            continue
        absolute_start = capture_start.timestamp() + segment.start
        absolute_end = capture_start.timestamp() + segment.end
        result.append({
            "start": round(absolute_start - meeting_start.timestamp(), 3),
            "end": round(absolute_end - meeting_start.timestamp(), 3),
            "started_at": iso(datetime.fromtimestamp(absolute_start, tz=timezone.utc)),
            "ended_at": iso(datetime.fromtimestamp(absolute_end, tz=timezone.utc)),
            "speaker": {
                "display_name": capture["display_name"],
                "external_id": capture.get("external_id"),
                "role": capture.get("role", "participant"),
            },
            "text": text,
        })
    return result


def build_artifacts(meeting: dict[str, Any], segments: list[dict[str, Any]]) -> list[tuple[str, str, str, bytes]]:
    generated_at = iso(datetime.now(tz=timezone.utc))
    payload = {
        "meeting_id": meeting["meeting_id"],
        "title": meeting["title"],
        "language": LANGUAGE,
        "generated_at": generated_at,
        "source": "participant_audio",
        "segments": segments,
    }
    json_body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")

    text_lines = [
        f"Transcription - {meeting['title']}",
        f"Réunion du {meeting['starts_at']} au {meeting['ends_at']}",
        f"Générée le {generated_at} - langue: {LANGUAGE}",
        "",
    ]
    for segment in segments:
        speaker = segment["speaker"]
        identity = speaker.get("external_id") or "sans identifiant"
        text_lines.append(f"[{hhmmss(segment['start'])}] {speaker['display_name']} ({identity}): {segment['text']}")
    text_body = ("\n".join(text_lines) + "\n").encode("utf-8")

    srt_blocks = []
    for index, segment in enumerate(segments, start=1):
        srt_blocks.append(
            f"{index}\n{srt_time(segment['start'])} --> {srt_time(segment['end'])}\n"
            f"{segment['speaker']['display_name']}: {segment['text']}\n"
        )
    srt_body = ("\n".join(srt_blocks)).encode("utf-8")

    vtt_lines = ["WEBVTT", ""]
    for segment in segments:
        vtt_lines.append(f"{vtt_time(segment['start'])} --> {vtt_time(segment['end'])}")
        vtt_lines.append(f"<v {segment['speaker']['display_name']}>{segment['text']}")
        vtt_lines.append("")
    vtt_body = ("\n".join(vtt_lines)).encode("utf-8")

    return [
        ("transcript_json", "transcript.json", "application/json; charset=utf-8", json_body),
        ("transcript_txt", "transcript.txt", "text/plain; charset=utf-8", text_body),
        ("transcript_srt", "transcript.srt", "application/x-subrip; charset=utf-8", srt_body),
        ("transcript_vtt", "transcript.vtt", "text/vtt; charset=utf-8", vtt_body),
    ]


def _process_job(job_payload: dict[str, Any]) -> None:
    job = job_payload["job"]
    captures = job_payload.get("captures") or []
    log(f"job {job['id']} réunion {job['meeting_id']}: {len(captures)} piste(s)")
    if not captures:
        SESSION.post(
            f"{API_URL}/internal/jobs/{job['id']}/fail",
            json={"error": "Aucune capture audio participante disponible"},
            timeout=20,
        ).raise_for_status()
        return

    all_segments: list[dict[str, Any]] = []
    errors = []
    succeeded = 0
    for capture in captures:
        try:
            all_segments.extend(transcribe_capture(job, capture))
            succeeded += 1
        except Exception as error:  # une piste en échec ne doit pas bloquer les autres
            log(f"piste {capture.get('display_name')} en échec: {error}")
            errors.append(f"{capture.get('display_name')}: {error}")

    if succeeded == 0:
        raise RuntimeError(f"Aucune piste audio exploitable: {'; '.join(errors) or 'captures vides'}")

    all_segments.sort(key=lambda item: (item["start"], item["speaker"]["display_name"]))
    artifacts = build_artifacts(job, all_segments)
    registered = []
    for artifact_type, filename, mime, body in artifacts:
        key = f"meetings/{job['meeting_id']}/transcript/{filename}"
        S3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType=mime,
            Metadata={"meeting-id": job["meeting_id"], "language": LANGUAGE},
        )
        registered.append({
            "type": artifact_type,
            "filename": filename,
            "s3_key": key,
            "mime": mime.split(";")[0],
            "size": len(body),
            "metadata": {"speaker_count": len({s['speaker']['display_name'] for s in all_segments})},
        })

    response = SESSION.post(
        f"{API_URL}/internal/jobs/{job['id']}/complete",
        json={
            "language": LANGUAGE,
            "segments": len(all_segments),
            "artifacts": registered,
        },
        timeout=30,
    )
    response.raise_for_status()
    log(
        f"job {job['id']} terminé: {len(all_segments)} segment(s), "
        f"{len(registered)} artefact(s)"
        + (f", avertissements: {'; '.join(errors)}" if errors else "")
    )



def process_job(job_payload: dict[str, Any]) -> None:
    """Exécute le job en signalant régulièrement qu'il est vivant.

    Si l'API ou le worker redémarre, le job sans battement est remis en file
    après quelques minutes au lieu de rester bloqué en "processing".
    """
    job_id = job_payload["job"]["id"]
    stopped = threading.Event()

    def heartbeat() -> None:
        while not stopped.wait(45):
            try:
                SESSION.post(f"{API_URL}/internal/jobs/{job_id}/heartbeat", timeout=15).raise_for_status()
            except Exception as error:  # le battement ne doit jamais arrêter la transcription
                log(f"battement job {job_id} en échec: {error}")

    beat = threading.Thread(target=heartbeat, name=f"heartbeat-{job_id}", daemon=True)
    beat.start()
    try:
        _process_job(job_payload)
    finally:
        stopped.set()


def main() -> None:
    log(f"démarrage - API {API_URL}, modèle {MODEL_NAME}, langue {LANGUAGE}")
    while True:
        job_payload = None
        try:
            response = SESSION.get(f"{API_URL}/internal/jobs/next", timeout=30)
            if response.status_code == 204:
                time.sleep(POLL_SECONDS)
                continue
            response.raise_for_status()
            job_payload = response.json()
            process_job(job_payload)
        except requests.HTTPError as error:
            log(f"erreur HTTP: {error} - {error.response.text[:400] if error.response else ''}")
            if job_payload:
                try:
                    SESSION.post(
                        f"{API_URL}/internal/jobs/{job_payload['job']['id']}/fail",
                        json={"error": f"Erreur HTTP worker: {error}"},
                        timeout=20,
                    )
                except Exception:
                    pass
            time.sleep(POLL_SECONDS * 2)
        except Exception as error:
            log(f"erreur: {error}")
            if job_payload:
                try:
                    SESSION.post(
                        f"{API_URL}/internal/jobs/{job_payload['job']['id']}/fail",
                        json={"error": f"Erreur worker: {error}"},
                        timeout=20,
                    )
                except Exception:
                    pass
            time.sleep(POLL_SECONDS * 2)


if __name__ == "__main__":
    main()
