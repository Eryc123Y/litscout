import { execFileSync } from "node:child_process";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const reference = process.argv[2];
if (!reference)
  throw new Error(
    "Use node tools/verify-m1a-goldens.mjs REFERENCE_REPO [PYTHON_WITH_SCRAPY]",
  );
const python = process.argv[3] ?? path.join(reference, ".venv/bin/python");
const temporary = await mkdtemp(path.join(tmpdir(), "litscout-golden-"));
const root = process.cwd();
const program = String.raw`
import pathlib,sys,json,importlib.util,dataclasses
from scrapy.http import HtmlResponse
root=pathlib.Path(sys.argv[1]); temporary=pathlib.Path(sys.argv[2]); ref=pathlib.Path(sys.argv[3])
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file); result=importlib.util.module_from_spec(spec);sys.modules[name]=result;spec.loader.exec_module(result);return result
spider=module('reference_spider',temporary/'arxiv.py')
directory=root/'packages/sources/test/fixtures/listings'
for file in sorted(directory.glob('*.html')):
    kind='recent' if 'recent' in file.name else 'new'
    response=HtmlResponse(url=f'https://arxiv.org/list/cs.CV/{kind}?show=2000',body=file.read_bytes(),encoding='utf-8')
    actual=list(spider.ArxivSpider(categories='cs.CV',listing=kind).parse(response))
    assert actual==json.loads(file.with_suffix('.golden.json').read_text()),file.name
from summaries import interests,dedupe,prompting,localtask
fixture=json.loads((root/'packages/pipeline/test/fixtures/five-days.golden.json').read_text())
topics=interests.load_topics(temporary/'interest-presets.js');assert topics==fixture['topics']
for day in fixture['days']:
    assert [{'id':p['id'],'topics':interests.topics_for(p,topics)} for p in day['papers']]==day['expected'],day['day']
for case in json.loads((root/'packages/pipeline/test/fixtures/keyword-cases.json').read_text()):
    assert interests.keyword_matches(case['text'],case['keyword'])==case['matches'],case
@dataclasses.dataclass(frozen=True)
class Paper:
    record:dict
    abstract:str
for case in json.loads((root/'packages/pipeline/test/fixtures/dedupe.golden.json').read_text()):
    actual=dedupe.sort(case['existing'],[Paper(**p) for p in case['batch']],case['lacking'])
    assert dataclasses.asdict(actual)==case['expected']
for language,expected in json.loads((root/'packages/pipeline/test/fixtures/prompts.golden.json').read_text()).items():
    assert prompting.instructions(language)==expected['instructions']
    assert localtask.subagent_instructions(language)==expected['subagentInstructions']
print('Python reference verified: 4 listings, 5 weekdays / 100 papers, 42 keyword cases, 9 dedupe cases, 2 prompt locales')
`;
try {
  const summaries = path.join(reference, "summaries");
  await cp(summaries, path.join(temporary, "summaries"), {
    recursive: true,
    filter: (source) => source === summaries || source.endsWith(".py"),
  });
  await cp(
    path.join(reference, "js/interest-presets.js"),
    path.join(temporary, "interest-presets.js"),
  );
  await cp(
    path.join(reference, "daily_arxiv/daily_arxiv/spiders/arxiv.py"),
    path.join(temporary, "arxiv.py"),
  );
  process.stdout.write(
    execFileSync(python, ["-c", program, root, temporary, reference], {
      cwd: temporary,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: temporary,
      },
      encoding: "utf8",
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
