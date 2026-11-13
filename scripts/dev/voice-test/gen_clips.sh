#!/bin/bash
# Makes the synthetic caller clips (one question per language) with Soniox REST TTS into ./clips.
# Needs SONIOX_API_KEY (source ../../../.env.local first). Voices other than Priya so the caller sounds different.
set -e
cd "$(dirname "$0")"; mkdir -p clips
gen(){ python3 -c "import json,sys;print(json.dumps({'model':'tts-rt-v2','language':sys.argv[1],'voice':sys.argv[2],'audio_format':'wav','text':sys.argv[3]}))" "$1" "$2" "$3" | curl -s --max-time 60 -o clips/$4.wav -w "$4 %{http_code}\n" https://tts-rt.soniox.com/tts -H "Content-Type: application/json" -H "Authorization: Bearer $SONIOX_API_KEY" -d @-; }
gen en Bryce "Hi, what time do you close tonight, and how much is the butter chicken?" en
gen fr Bryce "Bonjour, est-ce que vous avez des options végétariennes, et combien coûte la pizza?" fr
gen hi Aarav "नमस्ते, आज आप कितने बजे बंद होते हैं, और बटर चिकन कितने का है?" hi
gen pa Gurpreet "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਅੱਜ ਤੁਸੀਂ ਕਿੰਨੇ ਵਜੇ ਬੰਦ ਹੁੰਦੇ ਹੋ, ਅਤੇ ਬਟਰ ਚਿਕਨ ਕਿੰਨੇ ਦਾ ਹੈ?" pa
gen ur Aarav "السلام علیکم، آج رات آپ کتنے بجے بند ہوتے ہیں، اور بٹر چکن کتنے کا ہے؟" ur
gen te Venkat "నమస్కారం, ఈ రోజు మీరు ఎన్ని గంటలకు మూసేస్తారు, బటర్ చికెన్ ధర ఎంత?" te
gen en Bryce "Great, thanks. Can I book a table for four people tomorrow at seven?" en2
