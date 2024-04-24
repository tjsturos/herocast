import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useAccount,
  useReadContract,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWalletClient,
} from "wagmi";
import { getBalance } from "@wagmi/core";
import {
  BUNDLER_ADDRESS,
  ViemWalletEip712Signer,
  bundlerABI,
  bytesToHexString,
} from "@farcaster/hub-web";
import { config } from "@/common/helpers/rainbowkit";
import {
  WARPCAST_RECOVERY_PROXY,
  getDeadline,
  getFidForAddress,
  getSignedKeyRequestMetadataFromAppAccount,
  readNoncesFromKeyGateway,
} from "../helpers/farcaster";
import { formatEther, toBytes, toHex } from "viem";
import {
  PENDING_ACCOUNT_NAME_PLACEHOLDER,
  useAccountStore,
} from "@/stores/useAccountStore";
import { AccountPlatformType, AccountStatusType } from "../constants/accounts";
import { generateKeyPair } from "../helpers/warpcastLogin";

import { Cog6ToothIcon } from "@heroicons/react/20/solid";
import { glideClient } from "../helpers/glide";
import { NoPaymentOptionsError } from "@paywithglide/glide-js";

const CreateFarcasterAccount = ({ onSuccess }: { onSuccess?: () => void }) => {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string>();
  const [transactionHash, setTransactionHash] = useState<`0x${string}`>("0x");
  const { address, isConnected } = useAccount();
  const walletClient = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();

  const { accounts, addAccount, setAccountActive } = useAccountStore();
  const pendingAccounts = accounts.filter(
    (account) =>
      account.status === AccountStatusType.pending &&
      account.platform === AccountPlatformType.farcaster
  );

  const { data: price } = useReadContract({
    address: BUNDLER_ADDRESS,
    abi: bundlerABI,
    functionName: "price",
    args: [0n],
  });

  const transactionResult = useWaitForTransactionReceipt({
    hash: transactionHash,
  });

  const getFidAndUpdateAccount = async (): Promise<boolean> => {
    console.log(
      "getFidAndUpdateAccount",
      address,
      "pending accounts",
      pendingAccounts.length,
      "transactionResult",
      transactionResult?.data
    );
    if (!(transactionResult && pendingAccounts.length > 0)) return false;

    return getFidForAddress(address!)
      .then(async (fid) => {
        if (fid) {
          const accountId = pendingAccounts[0].id!;
          await setAccountActive(accountId, PENDING_ACCOUNT_NAME_PLACEHOLDER, {
            platform_account_id: fid.toString(),
            data: { signupViaHerocast: true },
          });
          onSuccess?.();
          return true;
        }
        return false;
      })
      .catch((e) => {
        console.log("error when trying to get fid", e);
        setError(`Error when trying to get fid: ${e}`);
        return false;
      });
  };

  useEffect(() => {
    if (!isConnected || transactionHash === "0x") return;

    getFidAndUpdateAccount();
  }, [isConnected, transactionHash, transactionResult, pendingAccounts]);

  useEffect(() => {
    validateWalletHasNoFid();
  }, []);

  const validateWalletHasNoFid = async (): Promise<boolean> => {
    if (!address) return false;

    const fid = await getFidForAddress(address);
    if (fid) {
      setError(
        `Wallet ${address} has already registered FID ${fid} - only one account per address`
      );
      return false;
    }
    return true;
  };

  const validateWalletHasGasOnOptimism = async (): Promise<boolean> => {
    if (!address) return false;

    const { value } = await getBalance(config, {
      address,
    });
    console.log("balance", value, value > 0n);
    return value > 0n;
  };

  const createFarcasterAccount = async () => {
    console.log("createFarcasterAccount");

    if (!(await validateWalletHasNoFid())) return;

    setIsPending(true);

    let hexStringPublicKey: `0x${string}`, hexStringPrivateKey: `0x${string}`;

    if (!pendingAccounts || pendingAccounts.length === 0) {
      const { publicKey, privateKey } = await generateKeyPair();
      hexStringPublicKey = bytesToHexString(publicKey)._unsafeUnwrap();
      hexStringPrivateKey = bytesToHexString(privateKey)._unsafeUnwrap();

      try {
        await addAccount({
          account: {
            status: AccountStatusType.pending,
            platform: AccountPlatformType.farcaster,
            publicKey: hexStringPublicKey,
            privateKey: hexStringPrivateKey,
          },
        });
      } catch (e) {
        console.log("error when trying to add account", e);
        setIsPending(false);
        setError(`Error when trying to add account: ${e}`);
        return;
      }
    } else {
      hexStringPublicKey = pendingAccounts[0].publicKey;
      hexStringPrivateKey = pendingAccounts[0].privateKey!;
    }

    const nonce = await readNoncesFromKeyGateway(address!);
    const deadline = getDeadline();
    const userSigner = new ViemWalletEip712Signer(walletClient.data);
    const registerSignatureResponse = await userSigner.signRegister({
      to: address,
      recovery: WARPCAST_RECOVERY_PROXY,
      nonce,
      deadline,
    });
    if (registerSignatureResponse.isErr()) {
      console.log(
        "error when trying to sign register",
        registerSignatureResponse
      );
      setIsPending(false);
      setError(
        `Error when trying to sign register: ${JSON.stringify(
          registerSignatureResponse
        )}`
      );
      return;
    }
    const registerSignature = toHex(registerSignatureResponse.value);

    const metadata = await getSignedKeyRequestMetadataFromAppAccount(
      hexStringPublicKey,
      deadline
    );

    const addSignatureResponse = await userSigner.signAdd({
      owner: address,
      keyType: 1,
      key: toBytes(hexStringPublicKey),
      metadataType: 1,
      metadata,
      nonce,
      deadline,
    });

    if (addSignatureResponse.isErr()) {
      console.log("error when trying to sign add", addSignatureResponse);
      setError(`Error when trying to sign add: ${addSignatureResponse}`);
      setIsPending(false);
      return;
    }
    const addSignature = toHex(addSignatureResponse.value);

    try {
      if (!address) {
        throw new Error("No address");
      }

      const registerAccountTransactionHash = await glideClient.writeContract({
        account: address,
        chainId: 10,

        address: BUNDLER_ADDRESS,
        abi: bundlerABI,
        functionName: "register",
        args: [
          {
            to: address,
            recovery: WARPCAST_RECOVERY_PROXY,
            sig: registerSignature,
            deadline,
          },
          [
            {
              keyType: 1,
              key: hexStringPublicKey,
              metadataType: 1,
              metadata: metadata,
              sig: addSignature,
              deadline,
            },
          ],
          0n,
        ],
        value: price,

        switchChainAsync,
        sendTransactionAsync,
        signTypedDataAsync,
      });
      console.log(
        "registerAccountTransactionHash",
        registerAccountTransactionHash
      );

      setTransactionHash(registerAccountTransactionHash);
    } catch (e) {
      if (e instanceof NoPaymentOptionsError) {
        setError(
          "Wallet has no tokens to pay for transaction. Please add tokens to your wallet.",
        );
        setIsPending(false);
        return;
      }

      console.log("error when trying to write contract", e);
      const errorStr = String(e).split("Raw Call Arguments")[0];
      setError(`when adding account onchain: ${errorStr}`);
      setIsPending(false);
      return;
    }
  };

  return (
    <div className="w-3/4 space-y-4">
      <p className="text-[0.8rem] text-muted-foreground">
        This will require two wallet signatures and one on-chain transaction.{" "}
        <br />
        You can pay for the transaction and Farcaster platform fee with ETH or
        other tokens on Base, Optimism, Arbitrum, Polygon, or Ethereum.
        Farcaster platform fee (yearly) right now is{" "}
        {price
          ? `~${parseFloat(formatEther(price)).toFixed(5)} ETH.`
          : "loading..."}
      </p>
      <Button
        variant="default"
        disabled={isPending}
        onClick={() => createFarcasterAccount()}
      >
        Create account
        {isPending && (
          <div className="pointer-events-none ml-3">
            <Cog6ToothIcon
              className="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
          </div>
        )}
      </Button>
      {isPending && (
        <Button
          variant="outline"
          className="ml-4"
          onClick={() => getFidAndUpdateAccount()}
        >
          Manual refresh 🔄
        </Button>
      )}
      {error && (
        <div className="flex flex-start items-center mt-2">
          <p className="text-wrap break-all	text-sm text-red-500">
            Error: {error}
          </p>
        </div>
      )}

      <div>
        <a href="https://paywithglide.xyz" target="_blank" rel="noreferrer" className="text-sm cursor-pointer text-muted-foreground text-font-medium hover:underline hover:text-blue-500/70">
          Payments powered by Glide
        </a>
      </div>

    </div>
  );
};

export default CreateFarcasterAccount;
