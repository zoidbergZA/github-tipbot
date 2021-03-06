import React, { useState, useEffect } from 'react';
import app from '../base';
import * as firebase from 'firebase/app';
import { authState } from 'rxfire/auth';
import { doc } from 'rxfire/firestore';
import { map, switchMap } from 'rxjs/operators'
import { from } from 'rxjs';
import Spinner from 'components/Spinner/Spinner';
import Disclaimer from 'components/Disclaimer';

export const AuthContext = React.createContext();

export const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    // TODO: cleanup observable
    authState(app.auth())
    .pipe(
      switchMap(u => {
        if (u) {
          return doc(app.firestore().doc(`users/${u.uid}`));
        } else {
          setCurrentUser(null);
          setPending(false);
          return from([]);
        }
      }),
      map(userDoc => userDoc.data())
    ).subscribe(async (webAppUser) => {
      setCurrentUser(webAppUser);

      if (webAppUser) {
        firebase.analytics().setUserId(webAppUser.uid);

        const updateLinkedAccounts = app.functions().httpsCallable('webApp-callUpdateLinkedAccounts');
        await updateLinkedAccounts();

        setPending(false);
      }
    });
  }, []);

  if (pending) {
    return (
      <div style={{  paddingTop: "200px" }}>
        <Spinner />
      </div>
    )
  }

  if (currentUser && !currentUser.disclaimerAccepted) {
    return <Disclaimer></Disclaimer>
  }

  return (
    <AuthContext.Provider value={{ currentUser }}>
      {children}
    </AuthContext.Provider>
  );
};