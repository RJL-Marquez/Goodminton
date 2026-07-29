const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

code = code.replace(
  "const netSpeedScale = SMASH_NET_SLOWDOWN + (1 - SMASH_NET_SLOWDOWN) * netProximityFrac;\n      const speed = SMASH_BASE_SPEED * power * netSpeedScale * powerMultFor(p.character);\n\n      // the steep",
  "const netSpeedScale = SMASH_NET_SLOWDOWN + (1 - SMASH_NET_SLOWDOWN) * netProximityFrac;\n      let speed = SMASH_BASE_SPEED * power * netSpeedScale * powerMultFor(p.character);\n      if (spend === 'art') speed *= 1.25;\n\n      // the steep"
);

code = code.replace(
  "shuttle.kind = 'smash';\n\n      // flag this flight for the max-power dive adjustment in updateShuttle() — only armed\n      // for 5-star power characters, and only re-armed here so it can only trigger once per smash\n      shuttle.hitByMaxPower = !!(p.character && p.character.stats && p.character.stats.power === 5);\n      shuttle.hitDir = dir;",
  "shuttle.kind = 'smash';\n\n      // flag this flight for the max-power dive adjustment in updateShuttle() — only armed\n      // for 5-star power characters, and only re-armed here so it can only trigger once per smash\n      shuttle.hitByMaxPower = !!(p.character && p.character.stats && p.character.stats.power === 5) || (spend === 'art');\n      shuttle.hitDir = dir;"
);

// also for the gravity and terminal velocity
code = code.replace(
  "function currentShuttleGravity(){\n    return shuttle.maxPowerDiveApplied ? SMASH_MAXPOWER_DIVE_GRAVITY\n         : shuttle.dinkDiveApplied ? shuttle.dinkPostNetGravity\n         : shuttle.kind === 'dink' ? DINK_PRE_NET_GRAVITY\n         : SHUTTLE_GRAVITY;\n  }",
  "function currentShuttleGravity(){\n    return shuttle.maxPowerDiveApplied ? SMASH_MAXPOWER_DIVE_GRAVITY\n         : shuttle.dinkDiveApplied ? shuttle.dinkPostNetGravity\n         : shuttle.kind === 'dink' ? DINK_PRE_NET_GRAVITY\n         : (shuttle.ultFx && shuttle.ultFx.art && shuttle.kind !== 'smash' && shuttle.vy > 0) ? SHUTTLE_GRAVITY * 2\n         : SHUTTLE_GRAVITY;\n  }"
);

code = code.replace(
  "function currentShuttleTerminalVy(){\n    return shuttle.maxPowerDiveApplied ? SMASH_MAXPOWER_DIVE_TERMINAL_VY\n         : shuttle.dinkDiveApplied ? DINK_POST_NET_TERMINAL_VY\n         : shuttle.kind === 'dink' ? DINK_PRE_NET_TERMINAL_VY\n         : SHUTTLE_TERMINAL_VY;\n  }",
  "function currentShuttleTerminalVy(){\n    return shuttle.maxPowerDiveApplied ? SMASH_MAXPOWER_DIVE_TERMINAL_VY\n         : shuttle.dinkDiveApplied ? DINK_POST_NET_TERMINAL_VY\n         : shuttle.kind === 'dink' ? DINK_PRE_NET_TERMINAL_VY\n         : (shuttle.ultFx && shuttle.ultFx.art && shuttle.kind !== 'smash' && shuttle.vy > 0) ? SHUTTLE_TERMINAL_VY * 2\n         : SHUTTLE_TERMINAL_VY;\n  }"
);

fs.writeFileSync('index.html', code);
console.log("Patched index.html");
