"""摸鱼酒馆原创歌：ACE-Step 1.5 带人声。用法：cd ~/ai/ACE-Step-1.5 && uv run python ~/ai/bar/ace_bar.py [id ...]"""
import os, sys, time, json
ROOT = os.path.expanduser('~/ai/ACE-Step-1.5')
sys.path.insert(0, ROOT)
from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler
from acestep.inference import GenerationParams, GenerationConfig, generate_music

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
songs = json.load(open(os.path.join(HERE, 'songs.json'), encoding='utf-8'))
want = sys.argv[1:]
if want: songs = [s for s in songs if s['id'] in want]

t0 = time.time()
dit = AceStepHandler()
dit.initialize_service(project_root=ROOT, config_path='acestep-v15-turbo', device='mps', offload_to_cpu=True)
llm = LLMHandler()
print(f'load {time.time()-t0:.0f}s', flush=True)
for s in songs:
    t = time.time()
    p = GenerationParams(caption=s['caption'], lyrics=s['lyrics'], instrumental=False, vocal_language='zh',
                         duration=s.get('duration', 75), bpm=s.get('bpm'), seed=s.get('seed', -1), thinking=False)
    r = generate_music(dit, llm, p, GenerationConfig(batch_size=1, audio_format='wav'), save_dir=os.path.join(OUT, s['id']))
    print(f"{s['id']}: {'ok' if r.success else 'FAIL ' + str(r.error)} {time.time()-t:.0f}s {[a['path'] for a in r.audios] if r.success else ''}", flush=True)
