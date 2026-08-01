---
name: ctf-crypto
description: Cryptography attack techniques for CTF challenges, including black‑box oracle analysis. Use when attacking encryption, hashing, signatures, ZKP, PRNG, or mathematical crypto problems involving RSA, AES, ECC, lattices, LWE, CVP, number theory, Coppersmith, Pollard, Wiener, padding oracle, GCM, CTR, key derivation, stream/block cipher weaknesses, or unknown encryption services.
license: MIT
allowed-tools: Bash Read Write Edit Glob Grep Task WebFetch WebSearch
metadata:
  user-invocable: "false"
---

# CTF Cryptography

## Trigger conditions
- A crypto CTF challenge is presented (network service, file, code snippet).
- An unknown encryption/decryption oracle is available (remote or local) and its algorithm must be identified before exploitation.
- The task requires breaking encryption, forging signatures, solving number‑theoretic problems, analysing PRNG outputs, or performing cryptanalysis.

## Applicability and scope
- **Environment**: Linux, macOS. Python with the packages listed in "Prerequisites". SageMath is opt‑in; prefer fpylll/cysignals, SymPy, Z3, and RsaCtfTool.
- **Out of scope**: Binary reverse engineering (`/ctf-reverse`), forensics/stego extraction (`/ctf-forensics`), generic pwn or web exploitation after the crypto layer is solved (`/ctf-pwn`, `/ctf-web`), adversarial ML (`/ctf-ai-ml`), or encoding puzzles without cryptanalysis (`/ctf-misc`).

## Workflow

Follow this top‑down decision tree. Each bullet links to a supporting file with full code.

### 1. Black‑box oracle triage (always first for unknown services)
When the server encrypts/decrypts arbitrary input and the algorithm is unknown:

1. **Measure expansion ratio**
   - Send plaintexts of lengths 1, 2, 4, 8, 16 bytes.
   - Record the exact ciphertext length; compute the ratio (e.g., 1:1, 1:2).
   - *Validation*: the ratio is constant across lengths; any deviation indicates padding or prefix/suffix injection.

2. **Zero‑plaintext test**
   - Send an all‑zero plaintext.
   - If the cipher is a simple xor‑based stream cipher (CT = PT ⊕ keystream), the ciphertext directly exposes the keystream.
   - *Validation*: keystream bytes are non‑zero (if zero, the cipher may be a block cipher with known‑plaintext requirements).

3. **Single‑byte differential analysis**
   - Send two plaintexts that differ in exactly one byte (e.g., 0x00 … vs 0x01 …).
   - Examine how many ciphertext bytes change and at which offsets → assesses diffusion and non‑linearity.
   - *Validation*: a linear/non‑cryptographic transformation will show predictable single‑byte changes; non‑linear diffusion points to a real cipher.

4. **Block‑boundary detection** (CTR‑like oracles)
   - Send plaintexts of varying lengths across suspected block sizes (4, 8, 12, 16, 32, 64 bytes).
   - Compare per‑block entropy and byte‑change propagation within versus across block boundaries.
   - *Validation*: a consistent boundary means the cipher uses that block size internally; no boundary at any tested size suggests a pure stream cipher or a correctly implemented CTR mode without block‑wise artefacts.

5. **GF(2) linearity test**
   - Gather at least **200** (state/nonce, keystream) pairs within the **same connection** (same key/session) by sending all‑zero plaintexts. Larger sample sizes improve detection confidence.
   - Build a linear system `A·x = b` over GF(2) and solve with Gaussian elimination (pivot on an identity sub‑matrix; mark inconsistent rows).
   - For typical scale (200 equations, ~97–200 unknowns) elimination completes in under 2 seconds.
   - **Branch — linear**: if a consistent solution exists, the keystream is a linear function of the state → recover the mapping matrix and decrypt the target ciphertext directly with matrix multiplication. Stop further algorithm identification.
   - **Branch — non‑linear**: if the system is inconsistent (failed rows ≥ 5% of equations), discard all linear‑cipher hypotheses (RC4, LFSR‑only, plain XOR). Proceed to step 6.

6. **Nonce/state reuse and predictability analysis** (when GF(2) is non‑linear)
   - Check for nonce reuse: send identical plaintexts in sequence and verify whether ciphertext repeats. If any two (state, keystream) pairs collide, nonce reuse is exploitable directly (GCM forbidden attack or keystream subtraction).
   - Check for low‑entropy state: truncate state to its first 2, 4, or 8 bytes; check whether identical truncated states produce identical keystream prefixes. If so, the effective state space is reduced → brute‑force or table‑lookup.
   - Check for temporal predictability: collect states across sequential connections and test for LCG/MT/LCG‑truncated patterns with linear‑recurrence solvers.
   - *Validation*: at least 500 samples with no collision and no prefix‑match for truncated states before concluding the state generator is cryptographically random.

7. **Systematic cipher elimination** (when all structural tests are negative)
   - If GF(2) is non‑linear, block boundaries are absent, and nonces show no reuse or low‑dimensional pattern, the cipher is likely a correctly implemented non‑linear cipher (AES‑CTR, ChaCha20, or a custom sponge construction).
   - At this point stop guessing individual algorithms. Either:
     - Obtain the challenge source code or a known writeup; or
     - Look for a side‑channel (timing, error‑message oracle, ciphertext‑length side‑channel) as the intended attack vector.
   - *Anti‑pattern*: iterating through RC4 → Salsa20 → AES → SHA‑keystream guesses without structural evidence wastes time and connection attempts.

8. **Data persistence**
   - Save every request/response pair (JSON, pickle) before the container or service disappears, enabling offline re‑analysis.

### 2. Classic ciphers
- Caesar, Vigenere, Atbash, substitution wheel, multi‑byte XOR, cascade XOR, deterministic OTP, many‑time pad, homophonic substitution, grid permutation, image‑based shift, Polybius square, XOR key recovery from file headers.
→ [classic-ciphers.md](classic-ciphers.md)

### 3. Modern cipher attacks
- **ECB**: block shuffling, byte‑at‑a‑time chosen‑plaintext suffix recovery (FeatherDuster), cut‑and‑paste block manipulation.
- **CBC**: bit‑flipping auth bypass, padding oracle, IV forgery + block truncation, padding oracle → CBC bitflip RCE, ciphertext forging via error‑message oracle, UnicodeDecodeError side‑channel.
- **CFB‑8**: static IV with 8‑bit feedback allows state reconstruction after 16 known bytes.
- **CBC‑MAC/OFB‑MAC**: XOR keystream for signature forgery.
- **OFB with invertible RNG**: known plaintext leaks state; run RNG backwards.
- **CTR**: constant cross‑block XOR difference (keystream propagation), GCM nonce reuse (forbidden attack, polynomial factoring over GF(2^128)).
- **S‑box collisions**: non‑permutation S‑box enables key recovery.
- **GF(2) elimination**: linear hash/cipher broken by Gaussian elimination.
- **Square attack**: 4‑round AES integral cryptanalysis.
- **DES weak keys in OFB**, **HMAC‑CRC linearity**, **weak key derivation**, **AES‑GCM with derived keys**, **Ascon‑like differential cryptanalysis**, **custom MAC forgery**, **HMAC key recovery** (XOR+addition), **Blum‑Goldwasser bit‑extension**, **hash length extension**, **compression oracle**, **hash time reversal**, **SRP bypass**, **modified AES S‑Box brute‑force**, **Rabin LSB parity oracle**, **noisy RSA LSB oracle correction**, **PBKDF2 pre‑hash bypass**, **MD5 multi‑collision**, **custom hash state reversal**, **CRC32 brute‑force**, **AES‑CBC ciphertext forging**, **sponge hash MITM**, **three‑round XOR key cancellation**, **CFB IV recovery from timestamp‑seeded PRNG**, **SHA‑256 basis attack**.
→ [modern-ciphers.md](modern-ciphers.md), [modern-ciphers-2.md](modern-ciphers-2.md), [modern-ciphers-3.md](modern-ciphers-3.md)

### 4. Stream ciphers
- LFSR (Berlekamp‑Massey, correlation attack, Galois tap recovery via autocorrelation), RC4 second‑byte bias, XOR consecutive‑byte correlation.
→ [stream-ciphers.md](stream-ciphers.md)

### 5. RSA attacks
- Small e, common modulus, Wiener, Pollard p‑1, Hastad broadcast, Hastad+Coppersmith, Franklin‑Reiter, Coppersmith structured primes, Fermat factoring, multi‑prime, restricted‑digit primes, Manger oracle (including OAEP timing variant), polynomial hash, GF(2)[x] CRT, affine over composite modulus, p=q validation bypass, cube root CRT, factoring from φ(n) multiple, weak keygen via base representation, gcd(e,φ)>1 exponent reduction, partial key recovery (dp/dq/qinv), CRT fault attack, homomorphic decryption bypass, small prime CRT decomposition, Montgomery timing attack, Bleichenbacher low‑exponent signature forgery, e=1 signature bypass.
→ [rsa-attacks.md](rsa-attacks.md), [rsa-attacks-2.md](rsa-attacks-2.md)

### 6. ECC / DSA
- Small subgroup, invalid curve, Smart's attack, fault injection, clock group DLP, Pohlig‑Hellman, ECDSA/DSA nonce reuse, Ed25519 torsion side channel, DSA key recovery via MD5 collision on k‑generation.
→ [ecc-attacks.md](ecc-attacks.md)

### 7. ZKP / advanced
- Graph 3‑colouring, Z3 solver, garbled circuits, Shamir SSS, bigram constraints, Groth16 broken setup, DV‑SNARG forgery, KZG pairing oracle, reused polynomial coefficients.
→ [zkp-and-advanced.md](zkp-and-advanced.md)

### 8. PRNG attacks
- MT19937 state recovery, MT subset‑sum, LCG (forward/backward, truncated output), GF(2) matrix PRNG, V8 XorShift128+ via Z3, middle‑square, hill climbing, time‑based seeds, Java LCG meet‑in‑the‑middle, LFSR bit‑fold parity, Z3 solve‑time timing oracle, randcrack DSA k prediction, format‑string PRNG seed offset, NTP‑poisoned PRNG UUID XOR.
→ [prng.md](prng.md), [prng-attacks.md](prng-attacks.md)

### 9. Lattice / LWE
- LLL/BKZ/Babai, HNP from partial nonces, truncated LCG state recovery, LWE embedding (CVP), Ring‑LWE / Module‑LWE recognition, orthogonal lattices, subset sum / knapsack.
→ [lattice-and-lwe.md](lattice-and-lwe.md)

### 10. Exotic / algebraic
- Braid groups, monotone function inversion, tropical semiring, Paillier, Hamming code interleaving, ElGamal universal re‑encryption, FPE Feistel brute‑force, icosahedral group, Goldwasser‑Micali, BB‑84 QKD MITM, ElGamal trivial DLP, Paillier LSB oracle, differential privacy noise cancellation, homomorphic encryption bit‑extraction, ElGamal over matrices, OSS signature forgery, Cayley‑Purser bypass, BIP39 mnemonic checksum, Asmuth‑Bloom CRT, Rabin polynomial primes, LCG period detection, Vandermonde polynomial coefficient recovery.
→ [exotic-crypto.md](exotic-crypto.md), [exotic-crypto-2.md](exotic-crypto-2.md)

### 11. Historical / special
- Lorenz SZ40/42, book cipher.
→ [historical.md](historical.md), [advanced-math.md](advanced-math.md)

### 12. Automated tools
- **RsaCtfTool** (in dedicated venv). **hashcat** for password cracking. **FeatherDuster** for ECB byte‑at‑a‑time. **Gopherus** for SSRF‑to‑RCE when combined with crypto. **nonce‑disrespect** for GCM nonce reuse. SageMath only when strictly necessary.

## Validation standard
- **Oracle triage**: expansion ratio is constant; GF(2) elimination yields a definitive linear/non‑linear verdict with ≥ 200 (state, keystream) pairs. Block‑boundary detection produces consistent or absent boundaries at all tested sizes. Nonce‑reuse check uses ≥ 500 samples before concluding cryptographic randomness.
- **Classic ciphers**: plaintext language constraints (entropy, known prefix) are satisfied.
- **Modern ciphers**: attack recovers at least one full block of plaintext or forges a valid ciphertext.
- **RSA**: factorization or private‑key recovery is reproducible; decrypts or signs correctly.
- **ECC/DSA**: private key recovered or signature forged.
- **PRNG**: state recovered, next outputs predicted.
- **Lattice**: solution satisfies original modulus constraints; CVP distance < bound.
- **Exotic**: algebraic identity holds and yields flag.

## Failure handling
- **Unexplained expansion ratio**: check for prefix/suffix; switch to chosen‑ciphertext approach.
- **GF(2) system inconsistent**: discard linear‑cipher hypotheses (RC4, LFSR, XOR‑only). Immediately pivot to nonce‑reuse and predictability analysis; do not iterate through individual non‑linear cipher guesses.
- **Block‑boundary scan negative at all sizes**: treat as a pure stream cipher or correctly implemented CTR mode. Do not force a block‑size assumption.
- **Nonce analysis shows no pattern**: the cipher is likely a properly implemented non‑linear construction. Stop guessing algorithms; obtain source/writeup or search for a side‑channel.
- **Oracle triage inconclusive**: collect more data and apply offline auto‑correlation and entropy analysis before hypothesising complex algorithms.
- **Attack produces no valid result**: re‑examine assumptions (padding, encoding, key length). If blocked by tool limitations, escalate to SageMath or custom C implementation.
- **Service / container expires**: restart and re‑collect basics; use saved data for offline work.

## Safety boundaries
- Only attack systems for which you have explicit authorisation (CTF, pentest engagement).
- Minimise queries to avoid rate‑limiting or DoS; respect service limits.
- Never exfiltrate sensitive data outside the testing environment.
- Do not modify production services; use non‑destructive oracles (padding oracle, timing) without altering target state.

## Prerequisites
