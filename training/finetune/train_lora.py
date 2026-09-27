#!/usr/bin/env python3
"""LoRA fine-tune of a small instruct model on TerePay's gold set. Run on a machine with an NVIDIA GPU (8 GB is enough
for a 1.5B/3B model in 4-bit); NOT on the Pi. Typical runtime: 20-60 minutes.

    pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git" trl datasets
    python train_lora.py --base unsloth/Llama-3.2-3B-Instruct --data ../out/train.jsonl --out terepay-analyst-3b
    # or: --base unsloth/Qwen2.5-1.5B-Instruct --out terepay-analyst-1.5b

Outputs a merged GGUF (q4_k_m) in <out>/ plus a Modelfile; copy both to the Pi and run:
    ollama create terepay-analyst -f Modelfile
"""
import argparse, json, os
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="unsloth/Llama-3.2-3B-Instruct")
ap.add_argument("--data", default="../out/train.jsonl")
ap.add_argument("--out", default="terepay-analyst-3b")
ap.add_argument("--epochs", type=float, default=2.0)
ap.add_argument("--lr", type=float, default=2e-4)
ap.add_argument("--max_seq", type=int, default=4096)
ap.add_argument("--quant", default="q4_k_m")
ap.add_argument("--batch", type=int, default=1)     # per-device batch; 1 fits a 6 GB card at 3k tokens
ap.add_argument("--accum", type=int, default=16)    # gradient accumulation; effective batch = batch x accum = 16
a = ap.parse_args()

from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

model, tok = FastLanguageModel.from_pretrained(a.base, max_seq_length=a.max_seq, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(model, r=16, lora_alpha=32, lora_dropout=0.0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"], use_gradient_checkpointing="unsloth")

ds = load_dataset("json", data_files=a.data, split="train")
def to_text(ex):
    return {"text": tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False)}
ds = ds.map(to_text, remove_columns=ds.column_names)

trainer = SFTTrainer(model=model, tokenizer=tok, train_dataset=ds, dataset_text_field="text",
    args=SFTConfig(output_dir=a.out + "-ckpt", per_device_train_batch_size=a.batch, gradient_accumulation_steps=a.accum, num_train_epochs=a.epochs,
                   learning_rate=a.lr, lr_scheduler_type="cosine", warmup_ratio=0.05, logging_steps=5, save_strategy="no",
                   bf16=True, max_seq_length=a.max_seq, packing=False, report_to="none"))
trainer.train()

# merged 16-bit weights -> GGUF for Ollama on the Pi
model.save_pretrained_gguf(a.out, tok, quantization_method=a.quant)
# Newer Unsloth releases write to "<out>_gguf/" rather than "<out>/"; normalise so the worker always fetches <out>/.
import shutil
os.makedirs(a.out, exist_ok=True)
for d in (a.out, a.out + "_gguf"):
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.endswith(".gguf") and d != a.out:
                shutil.move(os.path.join(d, f), os.path.join(a.out, f))
gguf = next(f for f in os.listdir(a.out) if f.endswith(".gguf"))
with open(os.path.join(a.out, "Modelfile"), "w") as f:
    f.write(f"""FROM ./{gguf}
PARAMETER temperature 0.1
PARAMETER num_ctx 6144
PARAMETER num_predict 350
# The fine-tuned model has internalised the judgement task; the production system prompt is still sent (short, stable prefix).
""")
print("done ->", a.out, gguf)
