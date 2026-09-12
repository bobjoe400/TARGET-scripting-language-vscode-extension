# The DX button ceiling

Two separate limits apply to `DX1`..`DXn`, and they come from different places. Both were measured rather than quoted.

*Part of the [T.A.R.G.E.T. Script](https://marketplace.visualstudio.com/items?itemName=bobjoe400.tm-target-script) VS Code extension. Back to the [README](../README.md).*

TARGET replaces your hardware with a virtual controller, and `DX1`..`DXn` are buttons on
it. Two separate limits apply, and they come from different places.

**What TARGET declares: 120 buttons.** Measured, not quoted - a script creating only a
virtual joystick was run and the resulting device's HID capabilities read live:

```
HID\THRUSTMASTERGAMEDEVICE
  usagePage=0x01 usage=0x04 (Joystick)   inputReport=33 bytes
  button caps: page=0x09 usage 1..120    value caps: 9
```

The report length confirms it: 1 report id + 15 bytes of button bits (120) + 8 axes at
16 bits + 1 byte of hat = 33 bytes. The 9 value caps are those 8 axes plus the hat,
matching the eight `DX_*_AXIS` constants exactly.

`defines.tmh` names `DX1..DX128` regardless, so **`DX121`-`DX128` have no button behind
them** and are reported as a warning.

**What the game reads: 32 or 128, the game's choice.** DirectInput defines two joystick
data formats:

| Data format | Structure | Buttons |
| --- | --- | --- |
| `c_dfDIJoystick` | `DIJOYSTATE` | `BYTE rgbButtons[32]` |
| `c_dfDIJoystick2` | `DIJOYSTATE2` | `BYTE rgbButtons[128]` |

So a button between `DX33` and `DX120` exists on the controller but is only seen by a
game reading `DIJOYSTATE2`. Elite Dangerous reads 32. That case is a hint, since it
cannot be judged from the script.

Neither is ever an error: exceeding either limit is silent, never a failure the script
can detect.

A figure of 56 buttons circulates in community documentation. The live measurement above
contradicts it, and no HID descriptor declaring 56 exists anywhere in the installation.
The measurement was taken with no physical devices attached, on TARGET 3.0.25; if the
declared count varies with attached hardware, re-run the check before trusting 120.
