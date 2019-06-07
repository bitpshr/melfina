pragma solidity ^0.4.0;

contract ProofOfExistence {
	mapping(string => bool) private proofs;

	event OnNotarize(string dataHash);
	event OnVerify(string dataHash, bool notarized);

	function notarize(string dataHash) public {
		proofs[dataHash] = true;
		OnNotarize(dataHash);
	}

	function verify(string dataHash) public returns (bool) {
		var notarized = proofs[dataHash];
		OnVerify(dataHash, notarized);
		return notarized;
	}
}
