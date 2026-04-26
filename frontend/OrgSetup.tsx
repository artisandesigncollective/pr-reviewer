import React, { useState } from 'react';

/**
 * PR-Reviewer: B2D SaaS Dashboard
 * 
 * Pain Point: Engineering teams spend 20% of their time reviewing basic PRs.
 * Solution: An autonomous agent that integrates with GitHub to review PRs 24/7.
 */

export const OrgSetup = () => {
  const [devSeats, setDevSeats] = useState(5);

  const handleCheckout = () => {
    console.log(`[PR-Reviewer] 💳 Initiating Checkout for ${devSeats} seats ($${devSeats * 15}/mo)`);
    alert(`Redirecting to Stripe to activate ${devSeats} seats...`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-8 flex items-center justify-center">
      <div className="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black text-white">PR-Reviewer AI</h1>
          <p className="text-slate-400 mt-2">Automate your GitHub pull requests.</p>
        </div>

        <div className="space-y-6">
          <div className="bg-slate-800 p-6 rounded-xl">
            <h3 className="font-bold text-white mb-2">1. Install GitHub App</h3>
            <p className="text-sm text-slate-400 mb-4">Grant the AI read/write access to your repositories so it can comment on and approve PRs.</p>
            <button className="bg-[#2da44e] text-white font-bold py-2 px-4 rounded w-full hover:bg-[#2c974b] transition">
              Install on GitHub
            </button>
          </div>

          <div className="bg-slate-800 p-6 rounded-xl">
            <h3 className="font-bold text-white mb-2">2. Choose Developer Seats</h3>
            <p className="text-sm text-slate-400 mb-4">$15/month per active developer.</p>
            
            <div className="flex items-center justify-between bg-slate-900 p-4 rounded-lg mb-4">
              <span className="text-slate-300 font-medium">Developer Seats</span>
              <div className="flex items-center space-x-4">
                <button onClick={() => setDevSeats(Math.max(1, devSeats - 1))} className="text-slate-400 hover:text-white px-2">-</button>
                <span className="text-xl font-bold text-white">{devSeats}</span>
                <button onClick={() => setDevSeats(devSeats + 1)} className="text-slate-400 hover:text-white px-2">+</button>
              </div>
            </div>

            <button onClick={handleCheckout} className="bg-blue-600 text-white font-bold py-3 px-4 rounded w-full hover:bg-blue-700 transition">
              Activate Subscription (${devSeats * 15}/mo)
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default OrgSetup;
