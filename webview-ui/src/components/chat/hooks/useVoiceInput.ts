import { useCallback, useEffect, useRef, useState } from "react"

import type { ExtensionMessage } from "@njust-ai/types"

import { vscode } from "@src/utils/vscode"

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
	if (typeof globalThis === "undefined") {
		return null
	}
	const g = globalThis as unknown as {
		SpeechRecognition?: SpeechRecognitionConstructor
		webkitSpeechRecognition?: SpeechRecognitionConstructor
	}
	return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null
}

function toRecognitionLang(uiLanguage: string | undefined): string {
	if (!uiLanguage || uiLanguage === "en") {
		return "en-US"
	}
	const normalized = uiLanguage.replace(/_/g, "-")
	const lower = normalized.toLowerCase()
	if (lower === "zh-cn") {
		return "zh-CN"
	}
	if (lower === "zh-tw") {
		return "zh-TW"
	}
	return "en-US"
}

function toWhisperLanguageHint(uiLanguage: string | undefined): string | undefined {
	if (!uiLanguage || uiLanguage.length < 2) {
		return undefined
	}
	return uiLanguage.replace(/_/g, "-").split("-")[0]?.toLowerCase()
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	const chunkSize = 0x8000
	let binary = ""
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
	}
	return btoa(binary)
}

export interface UseVoiceInputResult {
	/** User can try microphone (MediaRecorder and/or browser speech API) */
	supported: boolean
	isListening: boolean
	isTranscribing: boolean
	lastError: string | null
	toggleListening: () => void
	stopListening: () => void
}

type VoicePhase = "idle" | "recording" | "speech_api" | "transcribing"

/**
 * Voice → text: prefers MediaRecorder + extension Whisper (OpenAI API), falls back to Web Speech API.
 */
export function useVoiceInput(
	inputValue: string,
	setInputValue: (value: string) => void,
	uiLanguage: string | undefined,
	translate: (key: string, options?: Record<string, string>) => string,
): UseVoiceInputResult {
	const [phase, setPhase] = useState<VoicePhase>("idle")
	const [lastError, setLastError] = useState<string | null>(null)

	const inputValueRef = useRef(inputValue)
	const setInputValueRef = useRef(setInputValue)
	inputValueRef.current = inputValue
	setInputValueRef.current = setInputValue

	const mediaRecorderRef = useRef<MediaRecorder | null>(null)
	const mediaStreamRef = useRef<MediaStream | null>(null)
	const mediaChunksRef = useRef<Blob[]>([])
	const mediaMimeRef = useRef("audio/webm")
	const transcriptionRequestIdRef = useRef<string | null>(null)
	/** When true, next `MediaRecorder` `onstop` discards audio (no Whisper request). */
	const discardNextRecordingRef = useRef(false)

	const recognitionRef = useRef<SpeechRecognition | null>(null)
	const speechCommittedRef = useRef("")
	const speechFinalsRef = useRef("")

	const canGetUserMedia =
		typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
	const canSpeechApi = Boolean(getSpeechRecognitionConstructor())
	const supported = canGetUserMedia || canSpeechApi

	const isListening = phase === "recording" || phase === "speech_api"
	const isTranscribing = phase === "transcribing"

	const stopSpeechApi = useCallback(() => {
		const rec = recognitionRef.current
		if (rec) {
			try {
				rec.stop()
			} catch {
				try {
					rec.abort()
				} catch {
					// ignore
				}
			}
			recognitionRef.current = null
		}
	}, [])

	const releaseMediaStream = useCallback(() => {
		const stream = mediaStreamRef.current
		if (stream) {
			stream.getTracks().forEach((t) => t.stop())
			mediaStreamRef.current = null
		}
		mediaRecorderRef.current = null
	}, [])

	const stopListening = useCallback(() => {
		stopSpeechApi()
		const mr = mediaRecorderRef.current
		if (mr && mr.state !== "inactive") {
			discardNextRecordingRef.current = true
			try {
				mr.stop()
			} catch {
				releaseMediaStream()
				setPhase((p) => (p === "transcribing" ? p : "idle"))
			}
			return
		}
		releaseMediaStream()
		setPhase((p) => (p === "transcribing" ? p : "idle"))
	}, [releaseMediaStream, stopSpeechApi])

	const startSpeechApi = useCallback(() => {
		const Ctor = getSpeechRecognitionConstructor()
		if (!Ctor) {
			setLastError("no-speech-api")
			return
		}
		discardNextRecordingRef.current = true
		const mr = mediaRecorderRef.current
		if (mr && mr.state !== "inactive") {
			try {
				mr.stop()
			} catch {
				releaseMediaStream()
			}
		} else {
			releaseMediaStream()
		}
		speechCommittedRef.current = inputValueRef.current
		speechFinalsRef.current = ""
		const rec = new Ctor()
		rec.continuous = true
		rec.interimResults = true
		rec.lang = toRecognitionLang(uiLanguage)
		rec.onresult = (event: SpeechRecognitionEvent) => {
			let interim = ""
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i]!
				const piece = result[0]!.transcript ?? ""
				if (result.isFinal) {
					speechFinalsRef.current += piece
				} else {
					interim += piece
				}
			}
			setInputValueRef.current(
				speechCommittedRef.current + speechFinalsRef.current + interim,
			)
		}
		rec.onerror = (event: SpeechRecognitionErrorEvent) => {
			if (event.error === "aborted" || event.error === "no-speech") {
				return
			}
			setLastError(event.error)
		}
		rec.onend = () => {
			recognitionRef.current = null
			setPhase("idle")
		}
		recognitionRef.current = rec
		setLastError(null)
		try {
			rec.start()
			setPhase("speech_api")
		} catch {
			setPhase("idle")
			setLastError("start-failed")
		}
	}, [releaseMediaStream, uiLanguage])

	const sendBlobToExtension = useCallback(
		async (blob: Blob) => {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
			transcriptionRequestIdRef.current = id
			setPhase("transcribing")
			setLastError(null)
			try {
				const buf = await blob.arrayBuffer()
				const lang = toWhisperLanguageHint(uiLanguage)
				vscode.postMessage({
					type: "transcribeAudio",
					audioBase64: arrayBufferToBase64(buf),
					audioMimeType: blob.type || mediaMimeRef.current,
					transcriptionRequestId: id,
					values: lang ? { language: lang } : undefined,
				})
			} catch {
				setPhase("idle")
				transcriptionRequestIdRef.current = null
				setLastError("encode-failed")
			}
		},
		[uiLanguage],
	)

	const startMediaRecording = useCallback(async () => {
		stopSpeechApi()
		if (!canGetUserMedia) {
			startSpeechApi()
			return
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			mediaStreamRef.current = stream
			const preferred = [
				"audio/webm;codecs=opus",
				"audio/webm",
				"audio/mp4",
			]
			const mimeType = preferred.find((m) => MediaRecorder.isTypeSupported(m)) ?? ""
			mediaChunksRef.current = []
			discardNextRecordingRef.current = false
			const mr = mimeType
				? new MediaRecorder(stream, { mimeType })
				: new MediaRecorder(stream)
			mediaMimeRef.current = mr.mimeType || "audio/webm"
			mr.ondataavailable = (e) => {
				if (e.data.size > 0) {
					mediaChunksRef.current.push(e.data)
				}
			}
			mr.onstop = () => {
				mediaRecorderRef.current = null
				releaseMediaStream()
				const blob = new Blob(mediaChunksRef.current, { type: mediaMimeRef.current })
				mediaChunksRef.current = []
				if (discardNextRecordingRef.current) {
					discardNextRecordingRef.current = false
					setPhase("idle")
					return
				}
				void sendBlobToExtension(blob)
			}
			mr.start(250)
			mediaRecorderRef.current = mr
			setPhase("recording")
			setLastError(null)
		} catch {
			if (canSpeechApi) {
				startSpeechApi()
			} else {
				setLastError("mic-denied")
			}
		}
	}, [
		canGetUserMedia,
		canSpeechApi,
		releaseMediaStream,
		sendBlobToExtension,
		startSpeechApi,
		stopSpeechApi,
	])

	const toggleListening = useCallback(() => {
		if (phase === "transcribing") {
			return
		}
		if (phase === "recording") {
			discardNextRecordingRef.current = false
			const mr = mediaRecorderRef.current
			if (mr && mr.state !== "inactive") {
				try {
					mr.stop()
				} catch {
					setPhase("idle")
				}
			}
			return
		}
		if (phase === "speech_api") {
			stopSpeechApi()
			return
		}
		void startMediaRecording()
	}, [phase, startMediaRecording, stopSpeechApi])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const msg = event.data as ExtensionMessage
			if (msg.type === "transcriptionResult" && typeof msg.text === "string") {
				if (
					transcriptionRequestIdRef.current &&
					msg.transcriptionRequestId &&
					msg.transcriptionRequestId !== transcriptionRequestIdRef.current
				) {
					return
				}
				const base = inputValueRef.current
				const sep = base.length > 0 && !/\s$/.test(base) ? " " : ""
				setInputValueRef.current(base + sep + msg.text)
				transcriptionRequestIdRef.current = null
				setPhase("idle")
			} else if (msg.type === "transcriptionError") {
				if (
					transcriptionRequestIdRef.current &&
					msg.transcriptionRequestId &&
					msg.transcriptionRequestId !== transcriptionRequestIdRef.current
				) {
					return
				}
				const key = msg.values?.errorI18nKey
				const detail = msg.values?.detail
				if (typeof key === "string" && key.length > 0) {
					setLastError(
						typeof detail === "string" && detail
							? `${translate(key)} (${detail})`
							: translate(key),
					)
				} else {
					setLastError(translate("chat:voiceInput.errorTranscriptionFailed"))
				}
				transcriptionRequestIdRef.current = null
				setPhase("idle")
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [translate])

	useEffect(
		() => () => {
			discardNextRecordingRef.current = true
			const mr = mediaRecorderRef.current
			if (mr && mr.state !== "inactive") {
				try {
					mr.stop()
				} catch {
					releaseMediaStream()
				}
			} else {
				releaseMediaStream()
			}
			const rec = recognitionRef.current
			if (rec) {
				try {
					rec.abort()
				} catch {
					// ignore
				}
				recognitionRef.current = null
			}
		},
		[releaseMediaStream],
	)

	return {
		supported,
		isListening,
		isTranscribing,
		lastError,
		toggleListening,
		stopListening,
	}
}
