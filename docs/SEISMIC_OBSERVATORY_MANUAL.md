# Earthquake Prediction Engine — Seismic Observatory Field Manual
## A 3-Layer Deep Dive: From Layperson Intuition to Raw Mathematical Physics

```
========================================================================================
                      SEISMIC OBSERVATORY SCIENTIFIC FIELD MANUAL
                  Station AM.R1A3D — Berkeley Hills Seismic Network
========================================================================================
```

Welcome to the **Earthquake Prediction Engine Seismic Observatory Manual**. This guide is designed around the **3-Layer Onion Principle**:
1. 🟢 **Layer 1: The Layperson's Eye** — Plain-English intuition, practical analogies, and visual cues. No background in physics or geology required.
2. 🟡 **Layer 2: The Geophysical Science** — Sensor mechanics, wave propagation physics, signal processing theory, and seismological principles.
3. 🔴 **Layer 3: Raw Mathematics & Derivations** — The exact differential equations, filter transfer functions, discrete algorithms, and KaTeX mathematical formulations running under the hood at 100 Hz.

---

## Table of Contents
1. [Chapter 1: Multi-Channel Seismograms (The Oscilloscope)](#chapter-1-multi-channel-seismograms-the-oscilloscope)
2. [Chapter 2: High-Definition Spectrogram (STFT Waterfall)](#chapter-2-high-definition-spectrogram-stft-waterfall)
3. [Chapter 3: 24-Hour Helicorder Drum (The Daily Seismogram)](#chapter-3-24-hour-helicorder-drum-the-daily-seismogram)
4. [Chapter 4: STA/LTA Early Warning Telemetry & RSAM](#chapter-4-stalta-early-warning-telemetry--rsam)
5. [Chapter 5: 3D Particle Motion Hodogram Orbit](#chapter-5-3d-particle-motion-hodogram-orbit)
6. [Chapter 6: 700-Mile Regional Epicenter Radar & Wavefront Isochrones](#chapter-6-700-mile-regional-epicenter-radar--wavefront-isochrones)
7. [Chapter 7: 5-Band Urban & Environmental Profiler](#chapter-7-5-band-urban--environmental-profiler)
8. [Chapter 8: Peterson Noise Model & Ambient Power Spectral Density (PSD)](#chapter-8-peterson-noise-model--ambient-power-spectral-density-psd)
9. [Chapter 9: AI PhaseNet Neural Phase Probability & Wadati Distance](#chapter-9-ai-phasenet-neural-phase-probability--wadati-distance)
10. [Chapter 10: Real-Time Magnitude Estimation ($M_{pd}$, $\tau_c$)](#chapter-10-real-time-magnitude-estimation-m_pd-tau_c)

---

## Chapter 1: Multi-Channel Seismograms (The Oscilloscope)

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
The oscilloscope displays four live, squiggly lines gliding continuously from right to left across your screen. Each line represents the direct, physical trembling of the earth beneath the Berkeley Hills station at this very second.
* **The Green Line (`EHZ`)** is a **Geophone**. Think of it as an ultra-sensitive subterranean microphone listening to the heartbeat of the Earth. It measures the *speed* (velocity) at which the soil moves up and down. It can pick up footsteps in your house, waves crashing at Ocean Beach 15 miles away, or an earthquake on the other side of the planet.
* **The Blue, Orange, and Purple Lines (`ENZ`, `ENN`, `ENE`)** are **Accelerometers**. Think of them like the motion sensors inside an iPhone, but a thousand times more sensitive. They measure pure physical *impact* (acceleration) in three directions: Up/Down (`ENZ`), North/South (`ENN`), and East/West (`ENE`). When a truck rumbles by or a major quake strikes, these show the violent jolts.
* **The Translucent Green Shaded Band** in the center is the station's **Normal Baseline Corridor**. As long as the squiggly line stays inside this band, the earth is calm. When the wave suddenly bursts through the corridor, the badge flashes from `NORMAL` to `ELEVATED` or `WEIRD`.

---

### 🟡 Layer 2: Geophysical & Sensor Science (How It Works)
The station utilizes a **Raspberry Shake RS4D** multi-parameter geophysical instrument. 

1. **Electrodynamic Moving-Coil Geophone (`EHZ`)**:
   Consists of a copper wire coil suspended by precision springs around an internal permanent magnet. When ground motion occurs, inertia keeps the coil relatively stationary while the magnet moves with the Earth. The resulting relative motion induces an electrical voltage proportional to **ground velocity** ($\dot{u}(t)$) via Faraday's Law of Induction. The geophone has a natural resonant period of $4.5\text{ Hz}$ and is electronically damped to a damping factor of $h \approx 0.707$ (critical damping).
2. **Triaxial MEMS Capacitive Accelerometer (`ENZ`, `ENN`, `ENE`)**:
   Uses micro-machined polysilicon surface micro-structures suspended above capacitive plates. Acceleration causes mechanical deflection of the proof mass, altering differential capacitance proportional to **acceleration** ($\ddot{u}(t)$). It has a flat frequency response from $0\text{ Hz}$ (DC) to $50\text{ Hz}$ (Nyquist limit).
3. **Filtering Modes**:
   * **Bandpass (1–10 Hz)**: Isolates tectonic earthquake frequencies while rejecting long-period ocean swells (<0.5 Hz) and high-frequency acoustic chatter (>15 Hz).
   * **Highpass (1 Hz)**: Eliminates DC baseline drift, thermal tilt, and barometric fluctuations.
   * **Lowpass (2 Hz)**: Isolates deep regional teleseisms and large tectonic surface waves.
4. **10-Second Jitter Cushion & Phase-Locked Loop (PLL)**:
   Waveforms stream across the network in bursts. The observatory maintains a continuous 10-second historical buffer. The playhead runs at $t - 10.0\text{s}$ at exactly 60 FPS, absorbing packet latency and network jitter without dropping a single frame.

---

### 🔴 Layer 3: Raw Mathematics & DSP Derivations

#### 1. Geophone Electrodynamic Transfer Function
The Laplace-domain transfer function relating output voltage $E(s)$ to input ground velocity $V(s) = \mathcal{L}\{\dot{u}(t)\}$ is given by:

$$H_v(s) = \frac{E(s)}{V(s)} = \frac{G \cdot s^2}{s^2 + 2 h \omega_0 s + \omega_0^2}$$

Where:
* $G = 388 \text{ V / (m/s)}$ (Electrodynamic generator constant / sensitivity)
* $\omega_0 = 2\pi f_0 = 2\pi(4.5\text{ Hz}) \approx 28.274 \text{ rad/s}$ (Natural angular frequency)
* $h \approx 0.707$ (Damping factor)

#### 2. Digital 2nd-Order Butterworth Bandpass Filter
Continuous-time analog prototype bandpass transfer function with center frequency $\omega_0 = \sqrt{\omega_1 \omega_2}$ and bandwidth $B = \omega_2 - \omega_1$:

$$H(s) = \frac{B s}{s^2 + B s + \omega_0^2}$$

Applying the **Bilinear Z-Transform** with sample interval $T = \frac{1}{f_s} = 0.01\text{ s}$ ($100\text{ Hz}$):

$$s \leftarrow \frac{2}{T} \left( \frac{1 - z^{-1}}{1 + z^{-1}} \right)$$

Yields the discrete difference equation executed in real time:

$$y[n] = b_0 x[n] + b_1 x[n-1] + b_2 x[n-2] - a_1 y[n-1] - a_2 y[n-2]$$

#### 3. Peak Ground Acceleration (PGA) Conversion
Digital integer counts from the 24-bit ADC are converted to physical acceleration ($\text{m/s}^2$) via:

$$\text{PGA} = \text{counts} \times \frac{V_{\text{ref}}}{2^{23} - 1} \times \frac{1}{S_a} \times 9.80665 \quad \left[\text{m/s}^2\right]$$

Where $S_a$ is the accelerometer factory calibration sensitivity factor ($\text{V/g}$).

---

## Chapter 2: High-Definition Spectrogram (STFT Waterfall)

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
If the seismogram is an audio waveform, the spectrogram is a **musical score**. It breaks down ground motion by **pitch (frequency)** over time:
* **The Vertical Y-Axis** represents pitch from $0\text{ Hz}$ (deep, sub-audible earthquake rumbles at the bottom) up to $50\text{ Hz}$ (high-pitched vibrations like footsteps and machinery at the top).
* **The Color** shows energy intensity using an thermal heat palette:
  * ⬛ **Black / Deep Purple**: Total silence.
  * 🟪 **Violet / Magenta**: Normal ambient background whisper.
  * 🟧 **Orange / Gold**: Heavy vibrations (trucks, nearby activity).
  * ⬜ **Bright White**: Intense seismic energy release.
* **How to spot a real earthquake**: A local earthquake looks like an explosive, glowing **vertical pillar of light** spanning across all frequencies simultaneously, followed by a warm, lingering tail of low-frequency energy. Traffic looks like a blurry horizontal streak around 10–14 Hz.

---

### 🟡 Layer 2: Geophysical Science (How It Works)
The Earth's crust acts as a **dispersive, low-pass viscoelastic filter**. 
1. **High Frequencies (10–45 Hz)**: Attenuate rapidly over distance due to scattering and inelastic absorption ($Q$-factor attenuation). Only earthquakes occurring within ~50 miles can deliver strong high-frequency energy.
2. **Low Frequencies (0.1–3 Hz)**: Travel thousands of miles through the lithosphere without dying out. A magnitude 7.8 earthquake in Alaska or Turkey will show up on our Berkeley Hills spectrogram as a thick, glowing band confined strictly below $2\text{ Hz}$, while local noise appears higher up.
3. **Harmonic Vibrations**: Machinery and amplified concerts (like Greek Theatre shows) appear as distinct **horizontal spectral lines** at specific harmonic frequencies.

---

### 🔴 Layer 3: Raw Mathematics & DSP Derivations

#### 1. Discrete Short-Time Fourier Transform (STFT)
The live stream is segmented into overlapping temporal frames using a **256-point Hann window** ($N=256$) with a hop size of $R=16$ samples:

$$X[m, k] = \sum_{n=0}^{N-1} x[m R + n] \cdot w[n] \cdot e^{-j \frac{2\pi}{N} k n}, \quad k \in [0, N/2]$$

Where the Hann analysis window $w[n]$ minimizes spectral leakage:

$$w[n] = 0.5 \left( 1 - \cos\left(\frac{2\pi n}{N-1}\right) \right)$$

Frequency bin $k$ corresponds to physical frequency:

$$f_k = k \cdot \frac{f_s}{N} = k \cdot \frac{100\text{ Hz}}{256} = k \cdot 0.390625\text{ Hz}$$

#### 2. Logarithmic Power Spectral Density (Decibels)
Power spectral density $S[m, k]$ in decibels:

$$S[m, k] = 10 \log_{10}\left( |X[m, k]|^2 + \varepsilon \right)$$

Normalized to a dynamic display range $[S_{\text{min}}, S_{\text{max}}]$:

$$\hat{S}[m, k] = \text{clamp}\left( \frac{S[m, k] - S_{\text{min}}}{S_{\text{max}} - S_{\text{min}}}, 0.0, 1.0 \right)$$

Rendered into 32-bit RGBA pixel buffers via continuous interpolation across the **Inferno Colormap Polynomial Transfer Matrix**.

---

## Chapter 3: 24-Hour Helicorder Drum (The Daily Seismogram)

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
This is the classic paper seismograph drum seen in volcanic observatories and disaster movies.
* It shows **a full 24 hours of seismic history on a single display**.
* Read it **like a book from top to bottom**: each horizontal line represents exactly **30 or 60 minutes** of time.
* As time passes, a virtual stylus writes from left to right, then drops down to start the next line.
* **Quiet hours** appear as neat, thin, parallel dark lines.
* **Human daytime activity** thickens the lines into a dense "fuzzy ribbon".
* **An earthquake** creates a dramatic, jagged spike that breaks out of its row and spills into the rows above and below it.

---

### 🟡 Layer 2: Geophysical Science (How It Works)
The helicorder is the quintessential tool for tracking long-term trends and background station health:
1. **Diurnal Anthropogenic Quieting**: You can clearly identify human sleep/wake cycles. Around 5:30 AM local time, the lines begin thickening as highway traffic and commuter transit start up. At 11:00 PM, the lines thin out as the city goes to sleep.
2. **Teleseismic Detection**: When a distant major quake strikes across the ocean, the seismic waves take 10 to 30 minutes to travel through the Earth's mantle. On the helicorder, this appears as an extended, sinusoidal packet that slowly grows, peaks, and wanes over the course of 45 minutes across multiple lines.
3. **Min-Max Decimation**: Drawing every individual point across 24 hours (8,640,000 samples) would freeze any computer. Instead, the engine groups samples into 1-minute blocks and records the maximum positive and negative excursions, preserving $100\%$ of all spike peaks without visual data loss.

---

### 🔴 Layer 3: Raw Mathematics & Algorithms

#### 1. 2D Coordinate Transformation
For any sample at absolute UTC timestamp $\tau$:

$$\text{Row Index: } r(\tau) = \left\lfloor \frac{\tau - \tau_{\text{start}}}{T_{\text{row}}} \right\rfloor$$

$$\text{Horizontal Coordinate: } x(\tau) = \left( \frac{(\tau - \tau_{\text{start}}) \bmod T_{\text{row}}}{T_{\text{row}}} \right) \cdot W_{\text{canvas}}$$

$$\text{Vertical Centerline: } y_0(r) = r \cdot H_{\text{row}} + \frac{H_{\text{row}}}{2}$$

#### 2. Min-Max Envelope Extreme Value Decimation
For sample bucket $k$ containing $M$ samples:

$$V_{\text{min}}[k] = \min_{i=0 \dots M-1} x_i, \quad V_{\text{max}}[k] = \max_{i=0 \dots M-1} x_i$$

The canvas draws vertical line segments from $(x_k, y_0 - \alpha V_{\text{max}})$ to $(x_k, y_0 - \alpha V_{\text{min}})$, preserving Nyquist peak amplitudes.

---

## Chapter 4: STA/LTA Early Warning Telemetry & RSAM

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
How does a computer detect an earthquake within split seconds of the ground shaking?
* It calculates the **STA/LTA Ratio**:
  * **STA (Short-Term Average)**: Measures how loud the ground is **right now** (last 0.5 seconds).
  * **LTA (Long-Term Average)**: Remembers how loud the ground was **over the last 20 seconds**.
* Under normal quiet conditions, $\text{Right Now} \div \text{Memory} = 1.0\times$.
* When a primary seismic wavefront (P-wave) suddenly arrives, the instantaneous energy skyrockets while the 20-second memory is still calm. The ratio instantly spikes to **$6.5\times, 12\times,$ or $30\times$**!
* **The RSAM (Real-time Seismic Amplitude Measurement)** panel on the right measures overall seismic energy minute by minute, showing whether seismic rumbling is building up or dying down.

---

### 🟡 Layer 2: Geophysical Science (How It Works)
The **STA/LTA algorithm** (pioneered by Rex Allen in 1978) is the global gold standard for automated seismic phase detection used by the USGS, ShakeAlert, and Japan Meteorological Agency.
1. **Trigger On Threshold ($\eta = 6.5$)**: Declares a seismic event onset when $R(t) \ge 6.5$.
2. **Trigger Off Threshold ($\eta = 2.0$)**: Closes the event window once the coda wave energy falls back toward normal.
3. **Adaptive Thresholding**: Because LTA continuously adapts to background conditions, the station remains equally sensitive during the quiet dead of night or during a windy afternoon storm without suffering false triggers.
4. **RSAM**: Developed by the USGS Cascades Volcano Observatory to track volcanic tremor and swarm intensity. It computes the root-mean-square (RMS) amplitude over 60-second windows.

---

### 🔴 Layer 3: Raw Mathematics & DSP Derivations

#### 1. Characteristic Function $CF(t)$
Ground velocity is pre-processed through a non-linear characteristic function combining instantaneous energy and the time derivative (rate of change):

$$CF[n] = x[n]^2 + C_1 \cdot \left( \frac{x[n] - x[n-1]}{\Delta t} \right)^2$$

#### 2. Recursive Discrete Exponential Moving Averages
Rather than recomputing expensive sliding windows over thousands of samples, the engine uses **exponential recursive filters**:

$$\text{STA}[n] = c_{\text{sta}} \cdot CF[n] + (1 - c_{\text{sta}}) \cdot \text{STA}[n-1]$$

$$\text{LTA}[n] = c_{\text{lta}} \cdot CF[n] + (1 - c_{\text{lta}}) \cdot \text{LTA}[n-1]$$

Where the decay coefficients are determined by sample rate $f_s = 100\text{ Hz}$:

$$c_{\text{sta}} = 1 - e^{-\frac{1}{T_{\text{sta}} f_s}} = 1 - e^{-\frac{1}{0.5 \times 100}} \approx 0.0198$$

$$c_{\text{lta}} = 1 - e^{-\frac{1}{T_{\text{lta}} f_s}} = 1 - e^{-\frac{1}{20.0 \times 100}} \approx 0.0005$$

#### 3. Trigger Condition & Ratio
$$R[n] = \frac{\text{STA}[n]}{\text{LTA}[n]}$$

$$\text{State}[n] = \begin{cases} 
\text{TRIGGERED} & \text{if } R[n] \ge 6.5 \\
\text{NORMAL} & \text{if } R[n] < 2.0 \\
\text{State}[n-1] & \text{otherwise}
\end{cases}$$

#### 4. RSAM Formulation
For a 1-minute discrete epoch of $M = 6000$ samples:

$$\bar{x} = \frac{1}{M} \sum_{i=1}^M x_i$$

$$\text{RSAM} = \sqrt{\frac{1}{M} \sum_{i=1}^M \left(x_i - \bar{x}\right)^2} \quad [\text{Counts RMS}]$$

---

## Chapter 5: 3D Particle Motion Hodogram Orbit

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
Imagine attaching an LED light to a single grain of dirt directly beneath the station and taking a long-exposure photograph in the dark as an earthquake passes:
* **The Horizontal Plane (N-S vs E-W)**: Shows whether the ground is shaking in a straight line or swirling around in circles. The direction of the tilt points directly along the path to the earthquake!
* **The Vertical Plane (Z vs Horizontal)**: Shows ground rolls. During an earthquake, the ground doesn't just vibrate—it rolls in backwards somersaults like ocean waves rolling toward a beach.
* **The Glowing Trail**: Recent motion is bright and vivid; older motion fades into a ghost trail, letting you watch the orbital loops unfold in real time.

---

### 🟡 Layer 2: Geophysical Science (How It Works)
The hodogram visualizes the **polarization vector of elastic wavefields**:
1. **P-Waves (Primary / Compressional)**: Longitudinal motion. Particles vibrate **parallel** to the ray propagation path. In the vertical plane, the inclination angle reveals the apparent incidence angle of the incoming deep mantle wave.
2. **S-Waves (Secondary / Shear)**: Transverse motion. Particles vibrate strictly **perpendicular** to the ray path, splitting into $SH$ (horizontal shear) and $SV$ (vertical shear) components.
3. **Rayleigh Waves**: Ground roll resulting from the interference of P and SV waves at the free surface. Particles trace a distinctive **retrograde elliptical orbit** (counter-clockwise when wave travels left to right).
4. **Love Waves**: Purely horizontal transverse surface waves causing intense shear stress on building foundations.

---

### 🔴 Layer 3: Raw Mathematics & Polar Analysis

#### 1. 3D Displacement State Vector
At any instant $t$, ground motion across triaxial orthogonal channels forms a 3D vector:

$$\mathbf{u}(t) = \begin{bmatrix} u_E(t) \\ u_N(t) \\ u_Z(t) \end{bmatrix}$$

#### 2. Particle Motion Covariance Matrix
Over a rolling analysis window of $N$ samples:

$$\mathbf{C} = \frac{1}{N} \sum_{i=1}^N \left(\mathbf{u}_i - \bar{\mathbf{u}}\right)\left(\mathbf{u}_i - \bar{\mathbf{u}}\right)^T = \begin{bmatrix} \sigma_{EE}^2 & \sigma_{EN} & \sigma_{EZ} \\ \sigma_{NE} & \sigma_{NN}^2 & \sigma_{NZ} \\ \sigma_{ZE} & \sigma_{ZN} & \sigma_{ZZ}^2 \end{bmatrix}$$

#### 3. Eigendecomposition & Rectilinearity
Solving the characteristic equation $\det(\mathbf{C} - \lambda \mathbf{I}) = 0$ yields eigenvalues $\lambda_1 \ge \lambda_2 \ge \lambda_3 \ge 0$ and eigenvectors $\mathbf{v}_1, \mathbf{v}_2, \mathbf{v}_3$.
* **Rectilinearity (P-wave purity)**:
  $$L = 1 - \frac{\lambda_2 + \lambda_3}{2 \lambda_1}$$
  If $L \approx 1.0$, motion is strictly linear (pure P-wave). If $L \approx 0.0$, motion is circular or spherical.
* **Back-Azimuth Estimation ($\theta$)**:
  From the principal horizontal eigenvector $\mathbf{v}_1 = [v_E, v_N, v_Z]^T$:
  $$\theta = \text{atan2}(v_E, v_N) \pmod{360^\circ}$$

---

## Chapter 6: 700-Mile Regional Epicenter Radar & Wavefront Isochrones

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
A live tactical radar map centered directly on the Berkeley Hills station:
* **The Concentric Circles** mark distances from your station: **50 miles (Local)**, **150 miles (Regional)**, **400 miles (State)**, and **700 miles (Distant)**.
* **The Fault Lines**: Highlight major active tectonic boundaries across California and Nevada, including the Hayward Fault (which runs just 800 meters from our station!), the San Andreas Fault, and the Calaveras Fault.
* **Incoming Wavefronts**: When the USGS reports a significant earthquake, concentric ripples expand across the radar map showing the theoretical shockwaves racing toward your home with an exact **countdown timer**!

---

### 🟡 Layer 2: Geophysical Science (How It Works)
Earthquake early warning depends on the fundamental speed difference between seismic wave types and the speed of light:
1. **Electronic Telemetry vs Seismic Waves**: Information travels over fiber optic cables and radio at nearly the speed of light ($300,000\text{ km/s}$). Seismic waves travel through rock at roughly the speed of sound in stone ($3.5\text{ to } 6.0\text{ km/s}$).
2. **P-Wave Arrival (Compressional)**: Fast moving (~$6\text{ km/s}$). Rarely causes damage, but provides the first physical announcement of an earthquake.
3. **S-Wave Arrival (Shear)**: Slower (~$3.5\text{ km/s}$), carrying massive kinetic energy that bends buildings and ruptures pipelines.
4. **Warning Lead Time**: The farther you are from the epicenter, the greater the time gap between the P-wave alert and the destructive S-wave arrival.

---

### 🔴 Layer 3: Raw Mathematics & Geodesy

#### 1. Haversine Great-Circle Distance
For station coordinates $(\phi_1, \lambda_1)$ and earthquake epicenter $(\phi_2, \lambda_2)$:

$$\Delta \phi = \phi_2 - \phi_1, \quad \Delta \lambda = \lambda_2 - \lambda_1$$

$$a = \sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right)$$

$$d = 2 R_{\text{earth}} \cdot \arctan2\left(\sqrt{a}, \sqrt{1-a}\right) \quad (R_{\text{earth}} \approx 6371.0 \text{ km})$$

#### 2. Wavefront Travel-Time & Warning Time Equation
Using 1D crustal velocity models ($V_p \approx 6.0 \text{ km/s}$, $V_s \approx 3.5 \text{ km/s}$):

$$t_P = \frac{d}{V_p}, \quad t_S = \frac{d}{V_s}$$

The theoretical warning lead time $\Delta t_{\text{warning}}$ available before destructive S-waves arrive:

$$\Delta t_{\text{warning}} = t_S - t_P = d \left( \frac{1}{V_s} - \frac{1}{V_p} \right) = d \left( \frac{V_p - V_s}{V_p V_s} \right)$$

$$\Delta t_{\text{warning}} \approx d \cdot 0.11905 \text{ seconds per kilometer}$$

* For an earthquake $100\text{ km}$ away: **$11.9\text{ seconds}$ of warning**.
* For an earthquake $250\text{ km}$ away: **$29.8\text{ seconds}$ of warning**.

---

## Chapter 7: 5-Band Urban & Environmental Profiler

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
Earthquakes are rare, but the ground under your feet is never truly still. The Urban Profiler listens to the **living heartbeat of the city** across 5 distinct channels:
1. 🔴 **Cal Memorial Stadium (2–5 Hz)**: Picks up thousands of fans stomping and jumping in unison during California Golden Bears football games.
2. 🟣 **Greek Theatre (25–45 Hz)**: Picks up intense sub-bass and kick drums from live rock and EDM concerts coupling acoustically through the hillside.
3. 🟡 **Roadway Traffic (8–14 Hz)**: Monitors heavy semi-trucks, buses, and rush-hour freight along Highway 24 and I-80.
4. 🟢 **Indoor Human Activity (15–24 Hz)**: Detects footsteps, doors closing, and washing machines inside the house.
5. 🔵 **Wind & Tree Sway (0.1–0.5 Hz)**: Monitors large redwood trees rocking in Pacific storms and atmospheric wind shear.

---

### 🟡 Layer 2: Geophysical Science (How It Works)
Cultural microseisms and environmental vibrations each occupy specific mechanical resonance bands:
* **Acoustic-to-Seismic Coupling**: High-decibel sound waves from stadium PA systems or concert soundboards vibrate the air, which in turn vibrates the physical ground surface.
* **Soil Resonances**: The alluvial soil and Franciscan bedrock of the East Bay hills have natural harmonic frequencies that amplify specific vibrational frequencies.
* **Wind-Induced Strain**: Wind blowing against forest canopies exerts lever-arm torque through root systems directly into the bedrock, producing ultra-low frequency swells ($0.1\text{ to } 0.5\text{ Hz}$).

---

### 🔴 Layer 3: Raw Mathematics & Spectral Binning

#### 1. Band-Limited Spectral Power Integral
From the 256-point STFT magnitude spectrum $|X[k]|$, the average spectral power within frequency band $[f_{\text{low}}, f_{\text{high}}]$ is computed via:

$$k_{\text{low}} = \left\lceil \frac{f_{\text{low}}}{\Delta f} \right\rceil, \quad k_{\text{high}} = \left\lfloor \frac{f_{\text{high}}}{\Delta f} \right\rfloor \quad (\Delta f = 0.390625\text{ Hz})$$

$$P_{\text{band}} = \frac{1}{k_{\text{high}} - k_{\text{low}} + 1} \sum_{k=k_{\text{low}}}^{k_{\text{high}}} |X[k]|^2$$

#### 2. Rolling Baseline Deviation Ratio
Each band tracks a moving 4-minute median baseline $\bar{P}_{\text{ambient}}$:

$$\text{Deviation Ratio} = \frac{P_{\text{band}}(t)}{\bar{P}_{\text{ambient}}}$$

$$\text{Status} = \begin{cases} 
\text{ELEVATED} & \text{if } \text{Ratio} \ge 2.0 \\
\text{ANOMALOUS} & \text{if } \text{Ratio} \ge 4.0 \\
\text{NORMAL} & \text{otherwise}
\end{cases}$$

---

## Chapter 8: Peterson Noise Model & Ambient Power Spectral Density (PSD)

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
How quiet is your station?
* This chart compares the background noise of your station against the **quietest and loudest places on planet Earth**:
  * **The Lower Gray Curve (NLNM)**: The quietest seismic location on Earth (an abandoned granite vault hundreds of feet underground in a remote desert).
  * **The Upper Gray Curve (NHNM)**: The loudest acceptable seismic station (on an island coast surrounded by pounding ocean surf and highways).
* **Your Station (The Cyan Curve)** sits comfortably between the two. The lower your curve, the smaller and more distant the earthquakes your station can detect!

---

### 🟡 Layer 2: Geophysical Science (How It Works)
Developed by USGS geophysicist Jon Peterson in 1993, the **New Low Noise Model (NLNM)** and **New High Noise Model (NHNM)** are the worldwide standard reference models for seismological observatories:
1. **The Microseismic Peak (5–8 seconds period, ~0.15 Hz)**: Notice the big hump in the middle of the Peterson curves. That is caused by storm waves colliding in the middle of the Atlantic and Pacific oceans, creating standing acoustic waves that pound the seafloor and vibrate the entire North American continent!
2. **Instrument Self-Noise Floor**: At very high frequencies (>20 Hz), the curve shows the electronic thermal noise floor (Johnson–Nyquist noise) of the sensor's internal amplifier circuitry.

---

### 🔴 Layer 3: Raw Mathematics & Power Spectral Density

#### 1. Peterson Piecewise Empirical Polynomials
The Peterson reference curves are defined as piecewise polynomial functions of period $T = 1/f$ in units of decibels relative to $1\,(\text{m/s}^2)^2/\text{Hz}$:

$$\text{PSD}_{\text{Peterson}}(T) = A_i + B_i \log_{10}(T)$$

Where constants $A_i$ and $B_i$ are tabulate by the USGS across specific period intervals $[T_i, T_{i+1}]$.

#### 2. Welch's Overlapped Segment Averaging (WOSA)
The live station Power Spectral Density $\hat{P}_{xx}(f)$ is estimated using Welch's method across $K$ segments with $50\%$ overlap:

$$\hat{P}_{xx}(f_k) = \frac{1}{K \cdot U \cdot N} \sum_{i=1}^K \left| \sum_{n=0}^{N-1} x_i[n] \cdot w[n] \cdot e^{-j 2\pi f_k n} \right|^2$$

Where $U$ is the window energy normalization factor:

$$U = \frac{1}{N} \sum_{n=0}^{N-1} w[n]^2$$

Expressed in decibels:

$$\text{PSD}_{\text{dB}}(f) = 10 \log_{10}\left( \frac{\hat{P}_{xx}(f)}{1\,(\text{m/s}^2)^2/\text{Hz}} \right)$$

---

## Chapter 9: AI PhaseNet Neural Phase Probability & Wadati Distance

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
An artificial intelligence neural network is constantly watching the live seismogram:
* It outputs two live probability curves:
  * 🔵 **Blue Curve $P(P)$**: The probability that a P-wave (initial shock) just arrived.
  * 🟠 **Amber Curve $P(S)$**: The probability that an S-wave (destructive shear wave) just arrived.
* When an earthquake occurs, the blue line leaps up, followed seconds later by the amber line.
* **The Wadati Secret**: By measuring the exact number of seconds between the blue spike and the amber spike, the system instantly calculates **how many miles away the earthquake was** from a single station!

---

### 🟡 Layer 2: Geophysical Science (How It Works)
1. **PhaseNet Architecture**: PhaseNet is a deep convolutional residual neural network with a U-Net architecture trained on millions of labeled seismic waveforms from the Northern California Earthquake Data Center (NCEDC).
2. **Wadati Derivation**: In 1933, Japanese seismologist Kiyoo Wadati discovered that because P-waves and S-waves travel through the same rock at a fixed velocity ratio ($V_p / V_s \approx \sqrt{3} \approx 1.73$), the time difference $(t_S - t_P)$ scales directly and linearly with hypocentral distance.

---

### 🔴 Layer 3: Raw Mathematics & Wadati Mechanics

#### 1. The Wadati Distance Formulation
Let distance to hypocenter be $D$, origin time be $t_0$, P-wave arrival time be $t_P$, and S-wave arrival time be $t_S$:

$$t_P - t_0 = \frac{D}{V_p}, \quad t_S - t_0 = \frac{D}{V_s}$$

Subtracting the two equations eliminates unknown origin time $t_0$:

$$t_S - t_P = D \left( \frac{1}{V_s} - \frac{1}{V_p} \right) = D \left( \frac{V_p - V_s}{V_p V_s} \right)$$

Solving directly for hypocentral distance $D$:

$$D = \left( \frac{V_p \cdot V_s}{V_p - V_s} \right) \cdot (t_S - t_P) = k_{\text{Wadati}} \cdot \Delta t_{S-P}$$

For standard California continental crust with $V_p = 6.0\text{ km/s}$ and $V_s = 3.464\text{ km/s}$ ($V_p / V_s = \sqrt{3}$):

$$k_{\text{Wadati}} = \frac{6.0 \times 3.464}{6.0 - 3.464} = \frac{20.784}{2.536} \approx 8.195 \text{ km/s}$$

$$D \approx 8.20 \text{ km} \times (t_S - t_P)\text{ seconds} \approx 5.10 \text{ miles} \times \Delta t_{S-P}$$

---

## Chapter 10: Real-Time Magnitude Estimation ($M_{pd}$, $\tau_c$)

### 🟢 Layer 1: The Layperson's Eye (What Am I Looking At?)
How can you measure the size (magnitude) of an earthquake before the big waves even reach you?
* When you pluck a thin violin string, it vibrates with a high-pitched, rapid buzz.
* When you pluck a thick bass string, it vibrates with a deep, slow thud.
* **Earthquakes behave the exact same way**:
  * A small **Magnitude 2.0 quake** ruptures a tiny crack (a few meters long) and radiates high-pitched vibrations.
  * A major **Magnitude 7.0 quake** ruptures a massive fault rupture (tens of miles long) and radiates deep, long-period waves.
* By measuring the **initial period (pitch $\tau_c$)** and **peak height ($P_d$)** in the first 3 seconds of the P-wave, the engine estimates the magnitude before destructive S-waves arrive!

---

### 🟡 Layer 2: Geophysical Science (How It Works)
Pioneered by Hiroo Kanamori (Caltech) and Richard Allen (UC Berkeley), real-time magnitude estimation algorithms extract two independent parameters from the initial $3.0\text{-second}$ P-wave window ($t_P \le t \le t_P + 3.0\text{s}$):
1. **$\tau_c$ (Predominant Period Parameter)**: Represents the characteristic rupture dimension of the fault. Because $\tau_c$ is a frequency parameter, it is completely independent of earthquake distance or attenuation!
2. **$P_d$ (Peak Ground Displacement)**: Measures the maximum initial ground offset. Scales with seismic moment $M_0$ and distance $D$.

---

### 🔴 Layer 3: Raw Mathematics & Kanamori Derivations

#### 1. The Predominant Period $\tau_c$ Formula
Using Parseval's theorem, the ratio of ground velocity variance to ground displacement variance over the initial window $\tau_0 = 3.0\text{ s}$ yields:

$$r = \frac{\int_0^{\tau_0} \dot{u}(t)^2 dt}{\int_0^{\tau_0} u(t)^2 dt} = \frac{\int_0^{\tau_0} v(t)^2 dt}{\int_0^{\tau_0} d(t)^2 dt}$$

Where $v(t)$ is ground velocity and $d(t) = \int_0^t v(\xi) d\xi$ is ground displacement.

The predominant period $\tau_c$ is defined as:

$$\tau_c = \frac{2\pi}{\sqrt{r}} = 2\pi \sqrt{ \frac{\int_0^{\tau_0} d(t)^2 dt}{\int_0^{\tau_0} v(t)^2 dt} } \quad [\text{seconds}]$$

#### 2. Kanamori Empirical Magnitude Scaling
The seismic magnitude estimate $M_{\tau_c}$ scales logarithmically with $\tau_c$:

$$M_{\tau_c} = c_1 \cdot \log_{10}(\tau_c) + c_2$$

Where empirical California calibration parameters are $c_1 \approx 4.0$ and $c_2 \approx 5.5$.

#### 3. Peak Ground Displacement $P_d$ Magnitude Scaling
Combining peak displacement $P_d = \max_{t \in [0, 3]} |d(t)|$ with hypocentral distance $D$:

$$M_{P_d} = \alpha \cdot \log_{10}(P_d) + \beta \cdot \log_{10}(D) + \gamma$$

Where $\alpha \approx 1.05$, $\beta \approx 1.25$, $\gamma \approx 5.22$.

---

```
========================================================================================
                 Earthquake Prediction Engine — Station AM.R1A3D
                     UC Berkeley Hills Seismic Observatory
========================================================================================
```
