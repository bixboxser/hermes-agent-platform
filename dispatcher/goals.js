const { executeGoal } = require('./goalRunner');

async function runGoalTask(goal) {
  return executeGoal(goal);
}

module.exports = { runGoalTask };
